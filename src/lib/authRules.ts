// The password length rule, in ONE place.
//
// It lived in three: reset-password.tsx said 6, the sign-up screen said nothing
// at all and let the server answer, and GoTrue's own password_min_length was 6.
// Raising the server without raising the client would have produced the worst
// version of this -- a screen that tells you "use at least 6 characters",
// accepts 7, and then fails with a server error naming a different number.
// Both halves move together or neither does; see
// memory/feedback_guard_on_the_side_that_cannot_be_stale.md.
//
// Keep this in step with GoTrue's `password_min_length` in the Supabase auth
// config. The server is the one that cannot be stale; this is what stops the
// user ever meeting its error.
export const PASSWORD_MIN_LENGTH = 8

export const PASSWORD_TOO_SHORT = `Use at least ${PASSWORD_MIN_LENGTH} characters.`
