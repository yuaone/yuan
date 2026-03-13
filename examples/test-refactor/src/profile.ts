import { UserService, User } from './user';

export interface Profile {
  userId: number;
  bio: string;
  avatarUrl: string;
  followers: number;
}

export class ProfileService {
  private profiles: Profile[] = [
    { userId: 1, bio: 'Software engineer at ACME', avatarUrl: 'https://example.com/alice.jpg', followers: 120 },
    { userId: 2, bio: 'Product designer', avatarUrl: 'https://example.com/bob.jpg', followers: 85 },
  ];

  private userService: UserService;

  constructor(userService: UserService) {
    this.userService = userService;
  }

  getProfileWithUser(userId: number) {
    const user = this.userService.findUserById(userId);
    if (!user) {
      throw new Error(`User ${userId} not found`);
    }
    const profile = this.profiles.find(p => p.userId === userId);
    return { user, profile: profile ?? null };
  }

  enrichUserWithProfile(user: User) {
    const profile = this.profiles.find(p => p.userId === user.id);
    return { ...user, profile };
  }

  getTopProfiles(limit: number = 10) {
    return this.profiles
      .sort((a, b) => b.followers - a.followers)
      .slice(0, limit)
      .map(p => {
        const user = this.userService.findUserById(p.userId);
        return { profile: p, user };
      });
  }
}
