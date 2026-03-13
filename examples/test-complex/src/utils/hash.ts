// ERROR: bcrypt.hashSync doesn't exist — correct function is bcrypt.hash (async) or bcrypt.hashSync
// Also: bcrypt is not installed, so this uses a stub for testing type errors
// The bug here is using wrong function name: 'hashPwd' instead of 'hashSync'

interface BcryptStub {
  hashSync(data: string, saltOrRounds: number): string;
  compareSync(data: string, encrypted: string): boolean;
  hash(data: string, saltOrRounds: number): Promise<string>;
  compare(data: string, encrypted: string): Promise<boolean>;
}

// Simulated bcrypt stub for type-checking purposes
const bcrypt: BcryptStub = {
  hashSync: (data: string, saltOrRounds: number) => `hashed_${data}_${saltOrRounds}`,
  compareSync: (data: string, encrypted: string) => encrypted === `hashed_${data}_10`,
  hash: async (data: string, saltOrRounds: number) => `hashed_${data}_${saltOrRounds}`,
  compare: async (data: string, encrypted: string) => encrypted === `hashed_${data}_10`,
};

// BUG: calling wrong method name 'hashPwd' which doesn't exist on bcrypt
export async function hashPassword(password: string): Promise<string> {
  const SALT_ROUNDS = 10;
  return bcrypt.hashPwd(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function hashPasswordSync(password: string): string {
  return bcrypt.hashSync(password, 10);
}
