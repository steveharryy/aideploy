// Service Server - Updated for PAY-101
export interface HealthStatus {
  status: 'UP' | 'DOWN';
  timestamp: string;
  uptime: number;
}

export class PaymentServer {
  private startTime = Date.now();

  // GET /health
  public getHealth(): HealthStatus {
    return {
      status: 'UP',
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - this.startTime) / 1000)
    };
  }

  // Sample charge endpoint
  public charge(amount: number): { success: boolean; txId: string } {
    return {
      success: true,
      txId: `tx_${Date.now()}_${amount}`
    };
  }
}
