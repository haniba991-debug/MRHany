/**
 * Hardened Firestore Security Rules Test Suite
 * Verifies that all "Dirty Dozen" adversarial payloads return PERMISSION_DENIED.
 */

export interface SecurityTestCase {
  id: number;
  name: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  path: string;
  auth: { uid: string; email: string; email_verified: boolean } | null;
  payload?: Record<string, unknown>;
  expectedResult: 'PERMISSION_DENIED' | 'ALLOWED';
}

export const dirtyDozenTests: SecurityTestCase[] = [
  {
    id: 1,
    name: 'Unverified Email Spoof against Admin',
    operation: 'get',
    path: '/admins/admin_1',
    auth: { uid: 'spoof_uid', email: 'haniba991@gmail.com', email_verified: false },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Shadow Field Injection on UserProfile Create',
    operation: 'create',
    path: '/users/user_1',
    auth: { uid: 'user_1', email: 'user1@example.com', email_verified: true },
    payload: {
      uid: 'user_1',
      displayName: 'User One',
      language: 'ar',
      preferredModel: 'gemini-3.8-flash',
      memoryRetentionDays: 30,
      isAdmin: true, // Ghost field
      createdAt: 'SERVER_TIMESTAMP',
      updatedAt: 'SERVER_TIMESTAMP',
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Cross-Tenant Message Read by Another User',
    operation: 'get',
    path: '/messages/msg_user_2',
    auth: { uid: 'user_1', email: 'user1@example.com', email_verified: true },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'Identity Spoofing on ChatMessage Create',
    operation: 'create',
    path: '/messages/msg_spoof',
    auth: { uid: 'user_1', email: 'user1@example.com', email_verified: true },
    payload: {
      userId: 'user_2',
      role: 'user',
      content: 'Hello',
      skillUsed: 'ChatSkill',
      modelUsed: 'gemini-3.8-flash',
      tokensUsed: 12,
      createdAt: 'SERVER_TIMESTAMP',
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Orphaned Memory Creation Without Parent UserProfile',
    operation: 'create',
    path: '/memories/mem_orphan',
    auth: { uid: 'non_existent_user', email: 'ghost@example.com', email_verified: true },
    payload: {
      userId: 'non_existent_user',
      category: 'note',
      title: 'Orphan Note',
      content: 'Should fail exists() check on /users/non_existent_user',
      createdAt: 'SERVER_TIMESTAMP',
      updatedAt: 'SERVER_TIMESTAMP',
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Timestamp Forgery on Create',
    operation: 'create',
    path: '/users/user_1',
    auth: { uid: 'user_1', email: 'user1@example.com', email_verified: true },
    payload: {
      uid: 'user_1',
      displayName: 'User One',
      language: 'ar',
      preferredModel: 'gemini-3.8-flash',
      memoryRetentionDays: 30,
      createdAt: '2020-01-01T00:00:00Z',
      updatedAt: '2020-01-01T00:00:00Z',
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Immortal Field (createdAt) Mutation on Update',
    operation: 'update',
    path: '/memories/mem_1',
    auth: { uid: 'user_1', email: 'user1@example.com', email_verified: true },
    payload: {
      userId: 'user_1',
      category: 'note',
      title: 'Updated Title',
      content: 'Updated Content',
      createdAt: '2026-01-01T00:00:00Z', // Mutated createdAt
      updatedAt: 'SERVER_TIMESTAMP',
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'Value Poisoning on Update (Oversized String)',
    operation: 'update',
    path: '/memories/mem_1',
    auth: { uid: 'user_1', email: 'user1@example.com', email_verified: true },
    payload: {
      userId: 'user_1',
      category: 'note',
      title: 'Valid Title',
      content: 'A'.repeat(10000), // Exceeds 5000 maxLength
      createdAt: 'EXISTING_TIMESTAMP',
      updatedAt: 'SERVER_TIMESTAMP',
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'ID Poisoning Attack with Invalid Characters',
    operation: 'create',
    path: '/memories/invalid$id!@#',
    auth: { uid: 'user_1', email: 'user1@example.com', email_verified: true },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'Cross-User Profile Scraping',
    operation: 'get',
    path: '/users/user_2',
    auth: { uid: 'user_1', email: 'user1@example.com', email_verified: true },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Self-Assigned Admin Privilege Escalation',
    operation: 'create',
    path: '/admins/user_1',
    auth: { uid: 'user_1', email: 'attacker@example.com', email_verified: true },
    payload: {
      uid: 'user_1',
      createdAt: 'SERVER_TIMESTAMP',
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'Unauthorized Mutation of Immutable ChatMessage',
    operation: 'update',
    path: '/messages/msg_1',
    auth: { uid: 'user_1', email: 'user1@example.com', email_verified: true },
    payload: {
      content: 'Tampered history message',
    },
    expectedResult: 'PERMISSION_DENIED',
  },
];
