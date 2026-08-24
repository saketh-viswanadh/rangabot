import { CraftIcon } from "./craft-icon";
import type { TurnRecoveryAction, TurnRecoveryPlan } from "@/lib/turn-recovery";

type TurnRecoveryCardProps = {
  plan: TurnRecoveryPlan;
  busy: boolean;
  status?: string;
  onAction(action: TurnRecoveryAction): void;
};

export function TurnRecoveryCard({ plan, busy, status, onAction }: TurnRecoveryCardProps) {
  const button = (action: TurnRecoveryAction, secondary = false) => (
    <button type="button" className={secondary ? "secondary" : ""} onClick={() => onAction(action)} disabled={busy}>
      <CraftIcon name={action === "open-models" ? "model" : "arrow"} size={13} />
      {action === "open-models" ? "Open Models" : "Restore request"}
    </button>
  );
  return (
    <section className="turn-recovery" aria-label="Request recovery">
      <CraftIcon name="reply" size={15} />
      <div>
        <strong>{plan.title}</strong>
        <p>{plan.guidance} Nothing runs automatically.</p>
        <nav>{button(plan.primaryAction)}{plan.secondaryAction && button(plan.secondaryAction, true)}</nav>
        {status && <small role="status" aria-live="polite">{status}</small>}
      </div>
    </section>
  );
}
