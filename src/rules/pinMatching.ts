// Pairs a call's named argument with its instruction-registry pin. Shared by
// every check that needs that pairing (linter/instructionChecks.ts,
// linter/sclInstructionChecks.ts, analysis/documentIndex.ts), so repeated pin
// families (`InstructionPin.repeat`) and the casing fallback are decided in
// one place instead of drifting apart per module.
import { InstructionPin } from "./types";

export interface RegistryPinMatch {
  pin: InstructionPin;
  /** False when the argument only matched case-insensitively. */
  exactCase: boolean;
}

/** True when `argName` is one numbered member of `pin`'s repeated family --
 * the stem, then an in-range index with no leading zeros (`IN3`, not `IN03`). */
function isRepeatedPinMember(pin: InstructionPin, argName: string, ignoreCase: boolean): boolean {
  if (!pin.repeat || pin.name === null) return false;
  const stem = argName.slice(0, pin.name.length);
  if (ignoreCase ? stem.toLowerCase() !== pin.name.toLowerCase() : stem !== pin.name) return false;
  const suffix = argName.slice(pin.name.length);
  if (!/^(0|[1-9]\d*)$/.test(suffix)) return false;
  const index = Number(suffix);
  return index >= pin.repeat.from && (pin.repeat.to === undefined || index <= pin.repeat.to);
}

/** The registry pin a named call argument refers to, or undefined. An exact
 * spelling always wins over a case-insensitive one, and a fixed pin over a
 * repeated family at the same casing level -- so MUX's fixed `IN1` is never
 * mistaken for a member of its `IN` family. */
export function findRegistryPin(pins: InstructionPin[], argName: string): RegistryPinMatch | undefined {
  for (const exactCase of [true, false]) {
    const same = (name: string) => (exactCase ? name === argName : name.toLowerCase() === argName.toLowerCase());
    const fixed = pins.find((p) => !p.repeat && p.name !== null && same(p.name));
    if (fixed) return { pin: fixed, exactCase };
    const repeated = pins.find((p) => isRepeatedPinMember(p, argName, !exactCase));
    if (repeated) return { pin: repeated, exactCase };
  }
  return undefined;
}

/** The registry's own spelling of the argument `match` came from -- the pin
 * name, or for a repeated family the stem plus the argument's index. */
export function registrySpelling(match: RegistryPinMatch, argName: string): string {
  const name = match.pin.name ?? argName;
  return match.pin.repeat ? name + argName.slice(name.length) : name;
}

/** How a pin is labelled for a reader: `IN3..IN32` for a repeated family
 * (`IN3..INn` when the upper limit isn't transcribed), else its name. */
export function pinDisplayName(pin: InstructionPin): string | null {
  if (pin.name === null || !pin.repeat) return pin.name;
  return `${pin.name}${pin.repeat.from}..${pin.name}${pin.repeat.to ?? "n"}`;
}
