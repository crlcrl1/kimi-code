import { timingSafeEqual } from 'node:crypto';

import type { AccessPrincipal, AccessTokenStore } from './accessTokenStore';
import type { IAuthTokenService } from './authTokenService';

export type CredentialValidator = (candidate: string) => Promise<boolean>;
export type PrincipalResolver = (candidate: string) => Promise<AccessPrincipal | null>;

function timingSafeMatch(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createPrincipalResolver(
  authTokenService: IAuthTokenService,
  opts?: {
    readonly rpcToken?: string;
    readonly accessTokenStore?: Pick<AccessTokenStore, 'resolve'>;
  },
): PrincipalResolver {
  return async (candidate) => {
    if (await authTokenService.isValid(candidate)) {
      return { role: 'owner' };
    }
    if (opts?.rpcToken !== undefined && candidate.length > 0 && timingSafeMatch(candidate, opts.rpcToken)) {
      return { role: 'owner' };
    }
    if (opts?.accessTokenStore !== undefined) {
      return opts.accessTokenStore.resolve(candidate);
    }
    return null;
  };
}

export function createCredentialValidator(
  authTokenService: IAuthTokenService,
  rpcToken?: string,
  accessTokenStore?: Pick<AccessTokenStore, 'resolve'>,
): CredentialValidator {
  const resolvePrincipal = createPrincipalResolver(authTokenService, {
    rpcToken,
    accessTokenStore,
  });
  return async (candidate) => (await resolvePrincipal(candidate)) !== null;
}
