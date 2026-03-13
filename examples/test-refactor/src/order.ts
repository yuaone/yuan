import { UserService } from './user';

export interface Order {
  id: number;
  userId: number;
  product: string;
  amount: number;
  status: 'pending' | 'completed' | 'cancelled';
}

export class OrderService {
  private orders: Order[] = [
    { id: 1, userId: 1, product: 'Widget A', amount: 29.99, status: 'completed' },
    { id: 2, userId: 2, product: 'Widget B', amount: 49.99, status: 'pending' },
  ];

  private userService: UserService;

  constructor(userService: UserService) {
    this.userService = userService;
  }

  getOrderWithUser(orderId: number) {
    const order = this.orders.find(o => o.id === orderId);
    if (!order) return null;

    const user = this.userService.getUserById(order.userId);
    return { order, user };
  }

  getOrdersByUser(userId: number) {
    const user = this.userService.getUserById(userId);
    if (!user) {
      throw new Error(`User ${userId} not found`);
    }
    return this.orders.filter(o => o.userId === userId);
  }

  createOrder(userId: number, product: string, amount: number): Order {
    const user = this.userService.getUserById(userId);
    if (!user) {
      throw new Error(`Cannot create order: user ${userId} not found`);
    }
    const newOrder: Order = {
      id: this.orders.length + 1,
      userId,
      product,
      amount,
      status: 'pending',
    };
    this.orders.push(newOrder);
    return newOrder;
  }
}
