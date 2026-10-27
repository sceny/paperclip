import type { Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export function writeDecisionChange<T>(db: Db, write: (transaction: Db) => Promise<T>): Promise<T> {
  return db.transaction(async transaction => {
    await notifyDeliveryWork(transaction, DELIVERY_QUEUES.decisionContinuation);
    return write(transaction as unknown as Db);
  });
}
