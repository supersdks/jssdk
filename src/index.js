import { SuperSDKError } from './core/errors.js';
import { createSuperSDK, installInstanceGlobal, SDK_VERSION } from './runtime/createSuperSDK.js';

const defaultTarget = globalThis;
const SuperSDK = createSuperSDK({ target: defaultTarget });

export function installGlobal(target = defaultTarget) {
  if (target === defaultTarget) return installInstanceGlobal(SuperSDK, target);
  const isolated = createSuperSDK({ target });
  return installInstanceGlobal(isolated, target);
}

export { createSuperSDK, SuperSDKError, SDK_VERSION };
export default SuperSDK;
