// ERROR: Wrong import path (should be './login' not '../auth/login-service')
import { isTokenExpired, generateSessionId } from './login';

export interface RequestContext {
  userId?: number;
  sessionId?: string;
  authenticated: boolean;
}

export function createAuthMiddleware() {
  return function authMiddleware(token: string | null): RequestContext {
    if (!token) {
      return { authenticated: false };
    }

    // Simulate token parsing
    const parts = token.split('.');
    if (parts.length !== 3) {
      return { authenticated: false };
    }

    const expiresAt = parseInt(parts[1], 10);
    if (isTokenExpired(expiresAt)) {
      return { authenticated: false };
    }

    const sessionId = generateSessionId();
    return {
      userId: 1,
      sessionId,
      authenticated: true,
    };
  };
}
