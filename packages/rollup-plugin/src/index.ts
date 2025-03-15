import { createClient } from '@hey-api/openapi-ts';

export function heyApiPlugin(options?: {
  /**
   * `@hey-api/openapi-ts` configuration options.
   */
  config?: Parameters<typeof createClient>[0];
}) {
  return {
    buildStart: async () => {
      await createClient(options?.config);
    },
    name: 'hey-api-plugin',
  };
}
