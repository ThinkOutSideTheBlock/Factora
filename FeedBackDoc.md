
**Project**: Factora (ETHOnline 2026)  
**Track**: Selfie Check ($3,500)  
**Date**: September 2026

## 1. Selfie Check docs & integration flow

### What worked well
- Official `@worldcoin/idkit` v4 + `/signing` subpath is clean.
- `signRequest()` helper is reliable (we never hand-rolled crypto).
- Forwarding the proof byte-for-byte to `/api/v4/verify/{rp_id}` works exactly as documented.
- Nullifier extraction and replay protection is straightforward once you know the response shape (`result.nullifier` or `result.results[]`).

### What was confusing / missing
- The difference between `environment: "staging"` (Simulator) vs `"sandbox"` (real Sandbox app) is not emphasized enough in the main integration guide.
- Selfie Check is still gated behind a feature flag + email request. This is not clearly stated as a blocker in the main “Getting Started” flow.
- The response shape from the verify endpoint sometimes puts the nullifier at the top level and sometimes inside `results[]`. Documentation should show both.

### Integration experience
We successfully completed the full loop:
RP signature → IDKit request → proof → backend verification → trade unlocked.

## 2. Developer Portal navigation, search, product discovery & debugging

### Positive
- Creating an app and generating RP signing key is simple.
- The “Enable World ID 4.0” banner is clear.

### Pain points
- Search inside the Developer Portal is weak — hard to find Selfie Check specific settings.
- It is not obvious where to check whether the Selfie Check feature flag is actually enabled on your app.
- Debugging failed verifications is difficult because error messages are often generic (`validation_error`, `action is required`, etc.).

## 3. Sandbox App states, proof flows, test users, errors & edge cases

### What we tested
- Staging Simulator (successful end-to-end)
- Real Sandbox World ID app (Firebase App Distribution – `org.world.id.sandbox`)

### Issues encountered with the real Sandbox app
- Sign-up / Sign-in frequently fails.
- App detects VPN and blocks the user.
- After turning VPN off, the app still says “you don’t have access”.
- Cold start (fresh install) and Semi-cold (account recovery) flows are hard to complete because of the access/VPN issues.
- Hot path is the only one that partially works once the app is already logged in.
- The AI support was so weak and was not functional at all.

### Known limitations we hit
- Sandbox apps are not publicly listed → must use Firebase App Distribution / TestFlight.
- Access appears geo or account restricted even after invitation.
- Error messages in the Sandbox app are not developer-friendly.

## 4. What was confusing, missing, broken, or hard to test

| Area                        | Issue                                                                 | Severity |
|----------------------------|-----------------------------------------------------------------------|----------|
| Feature flag               | Selfie Check requires manual email approval                          | High     |
| Sandbox access             | VPN detection + “no access” even after invitation                    | High     |
| Documentation              | Staging vs Sandbox environment difference is under-documented        | Medium   |
| Verify response shape      | Nullifier location is inconsistent                                   | Medium   |
| Error messages             | Too generic for debugging                                            | Medium   |
| Cold / Semi-cold journeys  | Extremely hard to complete because of access issues                  | High     |

## 5. Recommendations
1. Make Selfie Check available by default in Sandbox (or give clearer self-serve activation).
2. Improve Sandbox app error messages and remove aggressive VPN blocking for invited testers.
3. Document the exact expected shape of the `/v4/verify` response for Selfie Check.
4. Add a “Sandbox Access Status” page inside the Developer Portal.

## 6. Final status of our integration
- Backend fully working (RP signature + proof verification + nullifier storage).
- Mandatory Selfie Check gate implemented for both Supplier and Investor agents.
- End-to-end tested with Simulator.
- Real Sandbox testing blocked by access/VPN issues (documented above).

We believe the integration is production-ready once Sandbox access is stable.
