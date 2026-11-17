// Mirror of the client-relevant constants in `protocol/experiment-v1.json` (WS-12-S1).
// The JSON file is the single source; `tests/experiment.test.mjs` asserts these values
// match it so the two cannot drift. The JSSDK never implements the bucketing algorithm.
export const EXPERIMENT_CONTRACT = Object.freeze({
  contract: 1,
  defaultNamespace: 'default',
  namespacePattern: /^[a-z][a-z0-9_]{1,31}$/,
  namespacesPerRequest: 10,
  customAttributesMax: 20,
  attributeKeyMaxChars: 64,
  attributeValueMaxChars: 256,
  customPrefix: 'attr.',
  expVidsMax: 500,
  staleAfterSec: 604800,
  exposureEvent: '$exp_exposure',
  eventParam: 'exp_vids',
  header: 'X-Super-AB-Vids',
  queryParam: 'super_ab_vids'
});
