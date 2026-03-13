export interface User {
  id: number;
  name: string;
  email: string;
  createdAt: Date;
}

export class UserService {
  private users: User[] = [
    { id: 1, name: 'Alice', email: 'alice@example.com', createdAt: new Date('2024-01-01') },
    { id: 2, name: 'Bob', email: 'bob@example.com', createdAt: new Date('2024-02-01') },
    { id: 3, name: 'Charlie', email: 'charlie@example.com', createdAt: new Date('2024-03-01') },
  ];

  findUserById(id: number): User | undefined {
    return this.users.find(u => u.id === id);
  }

  getAllUsers(): User[] {
    return [...this.users];
  }

  createUser(name: string, email: string): User {
    const newUser: User = {
      id: this.users.length + 1,
      name,
      email,
      createdAt: new Date(),
    };
    this.users.push(newUser);
    return newUser;
  }
}
