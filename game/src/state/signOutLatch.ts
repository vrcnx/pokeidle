// A one-way latch that says "this device is being signed out, stop writing".
//
// It lives in its own module for one reason: AuthContext.signOut has to set
// it, and GameContext has to read it, and GameContext already imports
// AuthContext — so putting it in either would be a cycle.
//
// WHY IT EXISTS. AuthContext.signOut deletes the local save blob and then
// calls location.replace("/"). It never unmounts GameProvider, so
// GameContext's pagehide / visibilitychange flush is still registered and
// fires DURING that navigation — strictly after the delete — recreating the
// blob with the departing account's bytes, owner stamp and sync bookkeeping.
//
// The result was that "Sign out" did not clear the device at all. The next
// person to sign in on that browser was seeded from the previous account's
// save, and inherited its __cloudv / __adoptseq too. On a shared or family
// machine that is one player's entire save handed to another.
//
// One-way on purpose: the page is navigating away, so there is no state to
// return to. A reload gives a fresh module instance with `false`.
let signingOut = false;

/** Called by AuthContext.signOut BEFORE it wipes storage. */
export function signOutStarted(): void {
  signingOut = true;
}

/** True once sign-out has begun; local-save writes must no-op. */
export function isSigningOut(): boolean {
  return signingOut;
}
