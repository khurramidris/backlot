import { Progress } from "@/components/ui/progress";
import { formatBytes, type Me } from "@/lib/engine";
import { cn } from "@/lib/utils";

/** Storage used against the plan's quota. Turns red once it's nearly full. */
export function StorageBar({ storage }: { storage: Me["storage"] }) {
  const pct = storage.quota_bytes
    ? Math.min(100, (storage.used_bytes / storage.quota_bytes) * 100)
    : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span>
          <span className="font-semibold">{formatBytes(storage.used_bytes)}</span>
          <span className="text-muted-foreground"> of {formatBytes(storage.quota_bytes)} used</span>
        </span>
        <span className="font-mono text-xs text-muted-foreground">{pct.toFixed(0)}%</span>
      </div>
      <Progress
        value={pct}
        className={cn("mt-2 rounded-none", pct >= 90 && "[&>div]:bg-destructive")}
        aria-label="Storage used"
      />
      {pct >= 90 ? (
        <p className="mt-2 text-xs text-destructive">
          Almost full. Delete old videos from your dashboard to make room.
        </p>
      ) : null}
    </div>
  );
}
