import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from 'c12';
import { sync } from 'cross-spawn';

import { parse } from './openApi';
import type { Client } from './types/client';
import type { Config, UserConfig } from './types/config';
import { getConfig, setConfig } from './utils/config';
import { getOpenApiSpec } from './utils/getOpenApiSpec';
import { registerHandlebarTemplates } from './utils/handlebars';
import { postProcessClient } from './utils/postprocess';
import { writeClient } from './utils/write/client';

type Dependencies = Record<string, unknown>;
interface PackageJson {
  dependencies?: Dependencies;
  devDependencies?: Dependencies;
  peerDependencies?: Dependencies;
}

/**
 * Dependencies used in each client. User must install these, without them
 * the generated client won't work.
 */
const clientDependencies: Record<Config['client'], string[]> = {
  '@hey-api/client-axios': ['axios'],
  '@hey-api/client-fetch': [],
  angular: ['@angular/common', '@angular/core', 'rxjs'],
  axios: ['axios'],
  fetch: [],
  node: ['node-fetch'],
  xhr: [],
};

type OutputProcesser = {
  args: (path: string) => string[];
  command: string;
  condition: (dependencies: Dependencies) => boolean;
  name: string;
};

/**
 * Map of supported formatters
 */
const formatters: Record<
  Extract<Config['output']['format'], string>,
  OutputProcesser
> = {
  biome: {
    args: (path) => ['format', '--write', path],
    command: 'biome',
    condition: (dependencies) => Boolean(dependencies['@biomejs/biome']),
    name: 'Biome (Format)',
  },
  prettier: {
    args: (path) => [
      '--ignore-unknown',
      path,
      '--write',
      '--ignore-path',
      './.prettierignore',
    ],
    command: 'prettier',
    condition: (dependencies) => Boolean(dependencies.prettier),
    name: 'Prettier',
  },
};

/**
 * Map of supported linters
 */
const linters: Record<
  Extract<Config['output']['lint'], string>,
  OutputProcesser
> = {
  biome: {
    args: (path) => ['lint', '--apply', path],
    command: 'biome',
    condition: (dependencies) => Boolean(dependencies['@biomejs/biome']),
    name: 'Biome (Lint)',
  },
  eslint: {
    args: (path) => [path, '--fix'],
    command: 'eslint',
    condition: (dependencies) => Boolean(dependencies.eslint),
    name: 'ESLint',
  },
};

const processOutput = (dependencies: Dependencies) => {
  const config = getConfig();
  if (config.output.format) {
    const formatter = formatters[config.output.format];
    if (formatter.condition(dependencies)) {
      console.log(`✨ Running ${formatter.name}`);
      sync(formatter.command, formatter.args(config.output.path));
    }
  }
  if (config.output.lint) {
    const linter = linters[config.output.lint];
    if (linter.condition(dependencies)) {
      console.log(`✨ Running ${linter.name}`);
      sync(linter.command, linter.args(config.output.path));
    }
  }
};

const inferClient = (dependencies: Dependencies): Config['client'] => {
  if (dependencies['@hey-api/client-axios']) {
    return '@hey-api/client-axios';
  }
  if (dependencies['@hey-api/client-fetch']) {
    return '@hey-api/client-fetch';
  }
  if (dependencies.axios) {
    return 'axios';
  }
  if (dependencies['node-fetch']) {
    return 'node';
  }
  if (Object.keys(dependencies).some((d) => d.startsWith('@angular'))) {
    return 'angular';
  }
  return 'fetch';
};

const logClientMessage = () => {
  const { client } = getConfig();
  switch (client) {
    case 'angular':
      return console.log('✨ Creating Angular client');
    case 'axios':
      return console.log('✨ Creating Axios client');
    case 'fetch':
      return console.log('✨ Creating Fetch client');
    case 'node':
      return console.log('✨ Creating Node.js client');
    case 'xhr':
      return console.log('✨ Creating XHR client');
  }
};

const logMissingDependenciesWarning = (dependencies: Dependencies) => {
  const { client } = getConfig();
  const missing = clientDependencies[client].filter(
    (d) => dependencies[d] === undefined,
  );
  if (missing.length > 0) {
    console.log(
      '⚠️ Dependencies used in generated client are missing: ' +
        missing.join(' '),
    );
  }
};

const getOutput = (userConfig: UserConfig): Config['output'] => {
  let output: Config['output'] = {
    format: false,
    lint: false,
    path: '',
  };
  if (typeof userConfig.output === 'string') {
    output.path = userConfig.output;
  } else {
    output = {
      ...output,
      ...userConfig.output,
    };
  }
  return output;
};

const getSchemas = (userConfig: UserConfig): Config['schemas'] => {
  let schemas: Config['schemas'] = {
    export: true,
    type: 'json',
  };
  if (typeof userConfig.schemas === 'boolean') {
    schemas.export = userConfig.schemas;
  } else {
    schemas = {
      ...schemas,
      ...userConfig.schemas,
    };
  }
  return schemas;
};

const getServices = (userConfig: UserConfig): Config['services'] => {
  let services: Config['services'] = {
    export: true,
    name: '{{name}}Service',
    operationId: true,
    response: 'body',
  };
  if (typeof userConfig.services === 'boolean') {
    services.export = userConfig.services;
  } else if (typeof userConfig.services === 'string') {
    services.include = userConfig.services;
  } else {
    services = {
      ...services,
      ...userConfig.services,
    };
  }
  return services;
};

const getTypes = (userConfig: UserConfig): Config['types'] => {
  let types: Config['types'] = {
    dates: false,
    enums: false,
    export: true,
    name: 'preserve',
  };
  if (typeof userConfig.types === 'boolean') {
    types.export = userConfig.types;
  } else if (typeof userConfig.types === 'string') {
    types.include = userConfig.types;
  } else {
    types = {
      ...types,
      ...userConfig.types,
    };
  }
  return types;
};

const getInstalledDependencies = (): Dependencies => {
  const packageJsonToDependencies = (pkg: PackageJson): Dependencies =>
    [
      pkg.dependencies ?? {},
      pkg.devDependencies ?? {},
      pkg.peerDependencies ?? {},
    ].reduce(
      (result, dependencies) => ({
        ...result,
        ...dependencies,
      }),
      {},
    );

  let dependencies: Dependencies = {};

  // Attempt to get all globally installed packages.
  const result = sync('npm', ['list', '-g', '--json', '--depth=0']);
  if (!result.error) {
    const globalDependencies: PackageJson = JSON.parse(
      result.stdout.toString(),
    );
    dependencies = {
      ...dependencies,
      ...packageJsonToDependencies(globalDependencies),
    };
  }

  // Attempt to read any dependencies installed in a local projects package.json.
  const pkgPath = path.resolve(process.cwd(), 'package.json');
  if (existsSync(pkgPath)) {
    const localDependencies: PackageJson = JSON.parse(
      readFileSync(pkgPath).toString(),
    );
    dependencies = {
      ...dependencies,
      ...packageJsonToDependencies(localDependencies),
    };
  }

  return dependencies;
};

const initConfig = async (
  userConfig: UserConfig,
  dependencies: Dependencies,
) => {
  const { config: userConfigFromFile } = await loadConfig<UserConfig>({
    jitiOptions: {
      esmResolve: true,
    },
    name: 'openapi-ts',
    overrides: userConfig,
  });

  if (userConfigFromFile) {
    userConfig = { ...userConfigFromFile, ...userConfig };
  }

  const {
    base,
    debug = false,
    dryRun = false,
    exportCore = true,
    input,
    name,
    request,
    useOptions = true,
  } = userConfig;

  if (debug) {
    console.warn('userConfig:', userConfig);
  }

  const output = getOutput(userConfig);

  if (!input) {
    throw new Error(
      '🚫 input not provided - provide path to OpenAPI specification',
    );
  }

  if (!output.path) {
    throw new Error(
      '🚫 output not provided - provide path where we should generate your client',
    );
  }

  if (!useOptions) {
    console.warn(
      '⚠️ Deprecation warning: useOptions set to false. This setting will be removed in future versions. Please migrate useOptions to true https://heyapi.vercel.app/openapi-ts/migrating.html#v0-27-38',
    );
  }

  const client = userConfig.client || inferClient(dependencies);
  const schemas = getSchemas(userConfig);
  const services = getServices(userConfig);
  const types = getTypes(userConfig);

  output.path = path.resolve(process.cwd(), output.path);

  return setConfig({
    base,
    client,
    debug,
    dryRun,
    exportCore: client.startsWith('@hey-api') ? false : exportCore,
    input,
    name,
    output,
    request,
    schemas,
    services,
    types,
    useOptions,
  });
};

/**
 * Generate the OpenAPI client. This method will read the OpenAPI specification and based on the
 * given language it will generate the client, including the typed models, validation schemas,
 * service layer, etc.
 * @param userConfig {@link UserConfig} passed to the `createClient()` method
 */
export async function createClient(userConfig: UserConfig): Promise<Client> {
  const dependencies = getInstalledDependencies();

  if (!dependencies.typescript) {
    throw new Error('🚫 dependency missing - TypeScript must be installed');
  }

  const config = await initConfig(userConfig, dependencies);

  const openApi =
    typeof config.input === 'string'
      ? await getOpenApiSpec(config.input)
      : (config.input as unknown as Awaited<ReturnType<typeof getOpenApiSpec>>);

  const client = postProcessClient(parse(openApi));
  const templates = registerHandlebarTemplates();

  if (!config.dryRun) {
    logClientMessage();
    logMissingDependenciesWarning(dependencies);
    await writeClient(openApi, client, templates);
    processOutput(dependencies);
  }

  console.log('✨ Done! Your client is located in:', config.output.path);

  return client;
}

/**
 * Type helper for openapi-ts.config.ts, returns {@link UserConfig} object
 */
export function defineConfig(config: UserConfig): UserConfig {
  return config;
}

export default {
  createClient,
  defineConfig,
};
