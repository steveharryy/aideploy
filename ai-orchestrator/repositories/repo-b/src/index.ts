export interface Order {
  id: string;
  items: string[];
  total: number;
}

export class OrderService {
  private orders: Map<string, Order> = new Map();

  createOrder(items: string[], total: number): Order {
    const id = `order_${Date.now()}`;
    const order: Order = { id, items, total };
    this.orders.set(id, order);
    return order;
  }

  getOrder(id: string): Order | undefined {
    return this.orders.get(id);
  }
}
