"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & {
  label: string;
  children: ReactNode;
  variant?: "ghost" | "outline" | "solid" | "danger";
  size?: "sm" | "md" | "lg";
};

export function IconButton({
  label,
  children,
  variant = "ghost",
  size = "md",
  className,
  type = "button",
  title,
  ...props
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={title ?? label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-brand transition-colors duration-150 disabled:pointer-events-none disabled:opacity-40",
        size === "sm" && "size-7",
        size === "md" && "size-8",
        size === "lg" && "size-9",
        variant === "ghost" && "text-text-muted hover:bg-bg-elevated hover:text-text-primary",
        variant === "outline" &&
          "border border-border-subtle text-text-muted hover:border-text-muted/35 hover:text-text-primary",
        variant === "solid" && "bg-bg-elevated text-text-primary hover:brightness-110",
        variant === "danger" &&
          "border border-recording-pulse/30 bg-recording-pulse/10 text-recording-pulse hover:bg-recording-pulse/15",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
