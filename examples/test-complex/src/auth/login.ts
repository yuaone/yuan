// Intentional TypeScript errors for testing

interface LoginRequest {
  username: string;
  password: string;
}

interface LoginResponse {
  token: string;
  expiresAt: number;
  user: {
    id: number;
    username: string;
  };
}

// ERROR 1: Return type mismatch — returning string instead of LoginResponse
export async function login(req: LoginRequest): Promise<LoginResponse> {
  if (!req.username || !req.password) {
    throw new Error('Missing credentials');
  }

  // ERROR 2: Property 'tok' does not exist on type LoginResponse
  const response: LoginResponse = {
    token: 'fake-jwt-token',
    expiresAt: Date.now() + 3600000,
    user: {
      id: 1,
      username: req.username,
    },
  };

  return response;
}

// ERROR 3: Parameter type error — passing string where number expected
export function isTokenExpired(expiresAt: number): boolean {
  const now: number = Date.now();
  return now > expiresAt;
}

export function generateSessionId(): string {
  return Math.random().toString(36).substring(2);
}
