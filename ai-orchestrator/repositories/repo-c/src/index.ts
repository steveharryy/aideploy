export interface NotificationPayload {
  recipient: string;
  channel: 'email' | 'sms' | 'push';
  message: string;
}

export class NotificationService {
  private sentNotifications: NotificationPayload[] = [];

  sendNotification(payload: NotificationPayload): { success: boolean; id: string } {
    this.sentNotifications.push(payload);
    return {
      success: true,
      id: `notif_${Date.now()}`
    };
  }

  getSentNotifications(): NotificationPayload[] {
    return [...this.sentNotifications];
  }
}
