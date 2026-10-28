import { variableInput } from "../shared/environment";
import type { z } from "zod";

type VariableInput = z.infer<typeof variableInput>;
interface EditorActions {
  save(variable: VariableInput): Promise<void>;
  remove(name: string): Promise<void>;
}
interface EditorState {
  name: string;
  description: string;
  value: string;
  revision: number;
  status: "idle" | "pending" | "saved" | "error";
  message: string;
  removing: string | null;
}

export class EnvironmentEditor {
  private state: EditorState = {
    name: "",
    description: "",
    value: "",
    revision: 0,
    status: "idle",
    message: "",
    removing: null,
  };
  private listeners = new Set<() => void>();
  constructor(private actions: EditorActions) {}
  getState = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<EditorState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  set(field: "name" | "description" | "value", value: string) {
    this.publish({ [field]: value, status: "idle", message: "" });
  }
  replace(name: string, description: string) {
    this.publish({
      name,
      description,
      value: "",
      revision: this.state.revision + 1,
      status: "idle",
      message: "",
    });
  }
  confirmRemove(name: string | null) {
    this.publish({ removing: name });
  }
  async save() {
    if (this.state.status === "pending") return;
    const result = variableInput.safeParse(this.state);
    if (!result.success) {
      this.publish({
        status: "error",
        message:
          "Enter an uppercase variable name, a nonempty value (up to 16 KiB), and a description up to 500 characters.",
      });
      return;
    }
    this.publish({
      status: "pending",
      value: "",
      revision: this.state.revision + 1,
      message: "Saving…",
    });
    try {
      await this.actions.save(result.data);
      this.publish({
        name: "",
        description: "",
        status: "saved",
        revision: this.state.revision + 1,
        message: "Saved. The next environment command will use this value.",
      });
    } catch {
      this.publish({
        status: "error",
        message: "Could not save. Re-enter the value and try again.",
      });
    }
  }
  async remove(name: string) {
    if (this.state.status === "pending" || this.state.removing !== name) return;
    this.publish({ status: "pending", message: "Removing…" });
    try {
      await this.actions.remove(name);
      this.publish({
        status: "saved",
        removing: null,
        message: `${name} removed. Commands already running keep their environment.`,
      });
    } catch {
      this.publish({ status: "error", message: "Could not remove this variable. Try again." });
    }
  }
}
