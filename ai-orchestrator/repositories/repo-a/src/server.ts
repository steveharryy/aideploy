export class PaymentServer {
  private startTime = Date.now();

  public charge(amount: number): { success: boolean; txId: string } {
    return {
      success: true,
      txId: `tx_${Date.now()}_${amount}`
    };
  }
}
