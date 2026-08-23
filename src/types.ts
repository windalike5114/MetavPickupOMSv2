export type OrderStatus = 'Created' | 'Picked Up' | 'Reviewed' | 'Cancelled';
export type WarehouseStatus = 'Pending' | 'Picking' | 'Picked';
export type PickupExceptionStatus = 'PartialPendingSales' | 'PendingFinalize';
export type PaymentStatus = 'Paid' | 'Unpaid';
export type PaymentMethod = 'Cash' | 'EFTPOS' | 'Bank Transfer' | 'Online Payment';
export type UserStatus = 'Active' | 'Disabled';
export type CounterPickupStatus = 'PendingPick' | 'Picked' | 'PendingPutback' | 'Finalized';
export type CounterPickupQueueStatus = 'Pending' | 'Picking' | 'Picked';
export type CounterPickupRequestType = 'counterPickup' | 'scheduledDelivery';
export type CounterPickupSourceType = 'metav' | 'offline' | 'blackfern' | 'other';
export type CounterPickupOutcome = 'sold' | 'returnedToWarehouse' | 'warrantySwapParts' | 'other';
export type CounterPickupLegacyDestination = 'Returned' | 'Sold' | 'Other';
export type CounterPickupFinalItemDestination = CounterPickupOutcome | CounterPickupLegacyDestination;

export interface SKU {
  id?: string;
  sku: string;
  productName: string;
  location: string;
  locations?: Record<string, string>;
  createdAt?: string;
  updatedAt?: string;
}

export interface Store {
  id?: string;
  storeId: string;
  name: string;
  senderEmail?: string;
  template: {
    subject: string;
    body: string;
  };
  disableEmail?: boolean;
  createdAt?: any;
}

export interface OrderItem {
  sku: string;
  productName?: string;
  location?: string;
  qty: number;
  unit_price: number;
  status?: 'Pending' | 'Picked';
}

export interface EmailLog {
  [type: string]: string; // type (e.g., 'pickup_notification') -> timestamp
}

export interface EmailTemplate {
  id?: string;
  name: string;
  subject: string;
  body: string; // HTML content with {{variables}}
  type: 'pickup_notification' | 'order_created' | 'custom';
  storeName?: string; // Optional: specific to a store
  status?: OrderStatus; // Optional: specific to a status
}

export interface StoreConfig {
  id: string; // Store Name
  senderEmail: string;
  templates?: {
    [key: string]: {
      subject: string;
      body: string;
    };
  };
  autoSend?: boolean;
}

export interface UserGroup {
  id?: string;
  name: string;
  userIds: string[];
}

export interface Notification {
  id?: string;
  recipientUid: string;
  title: string;
  body: string;
  type: 'New Order' | 'Order Picked Up' | 'System' | 'Inventory Issue';
  orderId?: string;
  isRead: boolean;
  createdAt: string;
}

export interface PickingLog {
  requestedAt?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  pickerId?: string | null;
  pickerName?: string | null;
  inventoryIssue?: string | null;
  issueReportedAt?: string | null;
}

export interface AuditLog {
  closed_by: string;
  closed_at: string;
  reason: 'Staff Missed Click' | 'Stock Missing' | 'Abandoned by Customer' | 'Other';
  note?: string;
}

export interface FollowUpLog {
  timestamp: string;
  staffName: string;
  content: string;
}

export interface PartialPickupInfo {
  confirmedAt: string;
  confirmedBy: string;
  reason: string;
  pickedItemIndexes: number[];
  pickedItems: Array<{
    sku: string;
    productName?: string;
    qty: number;
  }>;
  unpickedItems: Array<{
    sku: string;
    productName?: string;
    qty: number;
  }>;
  salesResolvedAt?: string | null;
  salesResolvedBy?: string | null;
  resolutionNote?: string | null;
  finalizedAt?: string | null;
  finalizedBy?: string | null;
}

export interface Order {
  id?: string;
  bookingNumber: string;
  refNumber: string;
  customerName: string;
  customerId: string;
  storeId: string;
  pickupDateScheduled: string;
  createdBy: string;
  creatorEmail?: string;
  creatorUid?: string;
  createdTime: string;
  items: OrderItem[];
  totalAmount: number;
  warehouseId: string;
  paymentStatus: PaymentStatus;
  paymentMethod?: PaymentMethod | null;
  paymentTime?: string | null;
  paymentBy?: string | null;
  actualPickupTime?: string | null;
  pickedUpBy?: string | null;
  customerSignature?: string | null;
  status: OrderStatus;
  warehouseStatus?: WarehouseStatus | null;
  pickingLog?: PickingLog;
  printedTime?: string | null;
  printedBy?: string | null;
  notes?: string | null;
  notificationRecipients?: string[] | null;
  customerEmail?: string;
  storeName?: string;
  emailStatus?: 'sent' | 'failed' | 'skipped' | null;
  lastEmailSentAt?: string | null;
  lastEmailAttemptAt?: string | null;
  lastEmailError?: string | null;
  sendPickupEmail?: boolean;
  emailLog?: EmailLog;
  auditLog?: AuditLog;
  followUpLogs?: FollowUpLog[];
  pickupExceptionStatus?: PickupExceptionStatus | null;
  partialPickupInfo?: PartialPickupInfo | null;
}

export type AccountType = 'Sales' | 'Reception' | 'Warehouse' | 'Admin';

export interface UserSettings {
  notificationsEnabled: boolean;
  emailNotifications: boolean;
  theme: 'light' | 'dark';
}

export interface UserProfile {
  uid: string;
  username: string;
  email?: string;
  name: string;
  status: UserStatus;
  permissions: string[];
  allowedWarehouses?: string[];
  roleTemplate?: AccountType;
  settings?: UserSettings;
  fcmToken?: string;
}

export interface OperationLog {
  id?: string;
  timestamp: string;
  userId: string;
  userName: string;
  action: string;
  category?: 'Audit' | 'Picking' | 'System' | 'Order' | 'User' | 'SKU' | 'Store' | 'Payment' | 'Counter Pickup';
  details: string;
  orderId?: string | null;
}

export interface CounterPickupItem {
  sku: string;
  productName: string;
  location: string;
  qty: number;
  requestType?: CounterPickupRequestType | null;
  sourceType?: CounterPickupSourceType | null;
  outcome?: CounterPickupOutcome | null;
  destination?: CounterPickupFinalItemDestination | null;
  orderNumber?: string | null;
  comment?: string | null;
  referenceNo?: string | null;
  otherNotes?: string | null;
  finalizedAt?: string | null;
  finalizedBy?: string | null;
  completedAt?: string | null;
  completedBy?: string | null;
}

export interface CounterPickupLog {
  id?: string;
  timestamp: string;
  operator: string;
  action: string;
  detail: string;
}

export interface CounterPickup {
  id: string;
  sku: string;
  productName: string;
  location: string;
  qty: number;
  warehouseId: string;
  requestType?: CounterPickupRequestType | null;
  sourceType?: CounterPickupSourceType | null;
  items?: CounterPickupItem[];
  status: CounterPickupStatus;
  queueStatus: CounterPickupQueueStatus;
  destination?: CounterPickupLegacyDestination | 'Mixed' | null;
  outcome?: CounterPickupOutcome | 'Mixed' | null;
  orderNumber?: string | null;
  comment?: string | null;
  referenceNo?: string | null;
  otherNotes?: string | null;
  pickupNote?: string | null;
  createdBy: string;
  createdByUid?: string;
  pickedBy?: string | null;
  pickedAt?: string | null;
  finalizedBy?: string | null;
  finalizedAt?: string | null;
  expiredBySystem?: boolean;
  expiredReason?: string | null;
  completedAt?: string | null;
  completedBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

export const PERMISSIONS = [
  'Create Order', 'Edit Order', 'View Orders', 'Search Orders',
  'Add Order Items', 'Edit Order Items',
  'Add Payment', 'Edit Payment', 'View Payment',
  'Print Pick List', 'Confirm Pickup', 'Capture Signature',
  'Review Orders', 'Cancel Orders',
  'View SKU', 'Upload SKU', 'Edit SKU',
  'Manage Users', 'Manage User Groups', 'Manage Stores', 'View Logs',
  'Request Picking', 'Manage Picking', 'View Picking Queue', 'Report Inventory Issue',
  'Audit Overdue Orders', 'Finalize Partial Pickup'
] as const;

export type Permission = typeof PERMISSIONS[number];

export const ROLE_TEMPLATES = {
  Sales: [
    'Create Order', 'Edit Order', 'Search Orders', 'View Orders',
    'Add Order Items', 'Edit Order Items',
    'Add Payment', 'Edit Payment', 'View Payment',
    'Cancel Orders'
  ],
  Reception: [
    'View Orders', 'Search Orders',
    'Add Payment', 'View Payment',
    'Print Pick List', 'Confirm Pickup', 'Capture Signature',
    'Request Picking'
  ],
  Warehouse: [
    'View Picking Queue', 'Manage Picking', 'Report Inventory Issue'
  ],
  Admin: [...PERMISSIONS]
};
