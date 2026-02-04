import * as React from "react";

import { cn } from "@/lib/utils";

export type BadgeProps = React.HTMLAttributes<HTMLDivElement>;

const Badge = React.forwardRef<HTMLDivElement, BadgeProps>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "inline-flex items-center rounded-full border border-zinc-200 bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-700",
        className
      )}
      {...props}
    />
  )
);
Badge.displayName = "Badge";

export { Badge };
