import { Expo, ExpoPushMessage } from 'expo-server-sdk';
import { logger } from '../lib/logger';

// Create a new Expo SDK client
// optionally providing an access token if you have enabled push security
const expo = new Expo();

export class PushService {
  /**
   * Send a push notification to a specific push token
   */
  static async sendPushNotification(pushToken: string, title: string, body: string, data?: any): Promise<any[] | undefined> {
    if (!Expo.isExpoPushToken(pushToken)) {
      logger.error(`Push token ${pushToken} is not a valid Expo push token`);
      return undefined;
    }

    const messages: ExpoPushMessage[] = [
      {
        to: pushToken,
        sound: 'default',
        title,
        body,
        data: data || {},
      },
    ];

    try {
      const chunks = expo.chunkPushNotifications(messages);
      const tickets = [];
      
      for (const chunk of chunks) {
        try {
          const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
          tickets.push(...ticketChunk);
        } catch (error) {
          logger.error({ err: error }, 'Error sending push notification chunk');
        }
      }
      
      logger.info({ tickets }, 'Push notification sent successfully');
      return tickets;
    } catch (error) {
      logger.error({ err: error }, 'Error sending push notification');
      return undefined;
    }
  }
}
