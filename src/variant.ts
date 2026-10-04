import type { Variant } from "../shared/types";

/**
 * Which side of the A/B test this build is. The production branch is "A";
 * the claude/variant-b-jev-loop branch sets this to "B". Every response and
 * feedback event is tagged with it.
 */
export const VARIANT: Variant = "B";
