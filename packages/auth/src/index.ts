// Service
export { createAuthService } from "./service";
export type {
  AuthService,
  AuthServiceOptions,
  IssueResponse,
  VerifyResponse,
  VerifyError,
} from "./service";

// Web Standard handlers
export { createHandlers } from "./handlers";
export type { AuthHandlers, AuthHandlerOptions } from "./handlers";

// Lower-level building blocks
export { issueChallenge, verifyChallenge } from "./challenge";
export type { IssuedChallenge, ChallengeVerifyResult } from "./challenge";

export { verifyAuthEvent } from "./verify";
export type {
  AuthEventVerifyOptions,
  AuthEventVerifyResult,
  VerifyFailReason,
} from "./verify";

export { signAuthJwt, verifyAuthJwt } from "./jwt";
export type { AuthJwtPayload, JwtOptions } from "./jwt";
