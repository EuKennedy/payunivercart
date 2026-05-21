/**
 * Event envelope + payload shapes that go on the wire.
 *
 * These types are the SOURCE OF TRUTH for the integration guide
 * (univercart-connect-integration.md). Any change here must be
 * reflected in the doc; partners pin to these shapes.
 */

export type EntitlementEventType =
  | 'entitlement.granted'
  | 'entitlement.role_changed'
  | 'entitlement.suspended'
  | 'entitlement.reactivated'
  | 'entitlement.revoked';

export interface UnivercartEvent<T extends EntitlementEventType, D> {
  id: string; // `evt_<uuid>`
  type: T;
  version: 'v1';
  created: number; // unix seconds
  livemode: boolean;
  data: D;
}

export interface EntitlementGrantedData {
  externalUserId: string;
  email: string;
  name: string;
  document: string;
  phone: string;
  role: string;
  productSlug: string;
  planId: string;
  billingPeriod: 'monthly' | 'yearly';
  amountCents: number;
  currency: 'BRL';
  validUntil: string;
  trial: boolean;
  trialEndsAt: string | null;
  magicLinkUrl: string;
  magicLinkJti: string;
}

export interface EntitlementRoleChangedData {
  externalUserId: string;
  email: string;
  previousRole: string;
  role: string;
  validUntil: string;
  effectiveAt: 'immediate';
}

export interface EntitlementSuspendedData {
  externalUserId: string;
  email: string;
  role: string;
  reason: 'payment_failed' | 'manual' | 'gateway_paused';
  attemptsMade: number;
  willRetryAt: string | null;
}

export interface EntitlementReactivatedData {
  externalUserId: string;
  email: string;
  role: string;
  validUntil: string;
}

export interface EntitlementRevokedData {
  externalUserId: string;
  email: string;
  role: string;
  reason: 'cancelled_by_buyer' | 'cancelled_by_producer' | 'refunded' | 'chargeback';
  revokedAt: string;
}

export type AnyEntitlementEvent =
  | UnivercartEvent<'entitlement.granted', EntitlementGrantedData>
  | UnivercartEvent<'entitlement.role_changed', EntitlementRoleChangedData>
  | UnivercartEvent<'entitlement.suspended', EntitlementSuspendedData>
  | UnivercartEvent<'entitlement.reactivated', EntitlementReactivatedData>
  | UnivercartEvent<'entitlement.revoked', EntitlementRevokedData>;
