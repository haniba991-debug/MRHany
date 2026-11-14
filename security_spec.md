# Security Specification (`security_spec.md`)

## 1. Data Invariants

1. **Global Default Deny**: Any path not explicitly matched in `firestore.rules` is unconditionally denied (`allow read, write: if false;`).
2. **Verified Identity**: Every write operation requires an authenticated user with a verified email (`request.auth != null && request.auth.token.email_verified == true`).
3. **Path Variable Hardening**: Every single-document ID variable (`{userId}`, `{messageId}`, `{memoryId}`, `{fileId}`, `{adminId}`) must satisfy `isValidId(id)` (`id is string && id.size() >= 1 && id.size() <= 128 && id.matches('^[a-zA-Z0-9_\\-]+$')`).
4. **Strict Tenant Isolation**: One user's conversation history, memories, profile, or file records must NEVER be readable or writable by another non-admin user (`resource.data.userId == request.auth.uid`).
5. **Relational Parent Existence (Global Consistency Invariant)**: Creating a `ChatMessage`, `UserMemory`, or `ProcessedFileRecord` requires that the parent `/users/$(request.auth.uid)` profile document exists (`exists(/databases/$(database)/documents/users/$(request.auth.uid))`).
6. **Temporal Integrity**: All `createdAt` and `updatedAt` fields must match `request.time` on creation, and `createdAt` is immutable on update while `updatedAt == request.time`.
7. **Zero Shadow Fields**: All `create` operations enforce `keys().hasAll(...) && keys().hasOnly(...)` and all `update` operations begin with `isValid[Entity](incoming())` and constrain modified keys via `affectedKeys().hasOnly(...)`.

## 2. The "Dirty Dozen" Adversarial Payloads

1. **Unverified Email Spoof**: Authenticated user with `email: "haniba991@gmail.com"` but `email_verified: false` attempting to read/write `/admins` or `/users`.
2. **Ghost / Shadow Field Injection on Create**: Creating `/users/{uid}` with an undeclared field `{"isAdmin": true}` or `{"role": "ADMIN"}`.
3. **Cross-Tenant Message Read (Query Scraping)**: Authenticated User A running a `list` query on `/messages` without `where("userId", "==", request.auth.uid)` or trying to read User B's message.
4. **Identity Spoofing on Create**: User A creating a document in `/messages/{msgId}` with `userId: "user_b_uid"`.
5. **Orphaned Record Creation**: Authenticated User A creating a `/memories/{memId}` document before `/users/{uid}` exists.
6. **Timestamp Forgery on Create**: Client passing a past or future timestamp (`createdAt: Timestamp.fromMillis(1000)`) instead of `serverTimestamp()` (`request.time`).
7. **Immortal Field Mutation on Update**: Updating `/users/{uid}` or `/memories/{memId}` while mutating `createdAt` or `uid` / `userId`.
8. **Value Poisoning on Update**: Updating `/memories/{memId}` with `affectedKeys().hasOnly(['title', 'content', 'updatedAt'])` where `content` is a 100,000-character string (exceeding `maxLength: 5000`) or an integer.
9. **ID Poisoning Attack**: Creating a document with a 500-character ID or special characters (`../../admin`).
10. **PII / Profile Scraping**: User B calling `get` or `list` on `/users/user_a_uid`.
11. **Privilege Escalation via `/admins`**: Non-bootstrapped user attempting to create `/admins/{theirUid}`.
12. **Unauthorized Message History Mutation**: Attempting to `update` an existing `/messages/{messageId}` record (messages are append-only/deletable by owner, never mutable after creation).
