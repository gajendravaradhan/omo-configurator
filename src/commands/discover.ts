import { PlutusError } from "../errors.ts";
export async function discover(args: { inventoryPath: string; write: boolean }): Promise<void> {
  void args;
  throw new PlutusError("discover: not implemented (W3 task)");
}