"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "outline";
export type ButtonSize = "xs" | "sm" | "md" | "lg";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-accent-primary text-bg-primary shadow-[inset_0_1px_0_0_color-mix(in_oklab,white_28%,transparent),0_6px_20px_-4px_color-mix(in_oklab,var(--brand-accent-primary)_45%,transparent)] hover:not-disabled:brightness-[1.06] active:not-disabled:brightness-95",
  secondary:
    "border border-[var(--glass-border-strong)] bg-[var(--glass-surface)] text-text-primary shadow-[var(--glass-highlight)] backdrop-blur-md hover:not-disabled:border-text-muted/35 hover:not-disabled:bg-[var(--glass-surface-strong)]",
  ghost:
    "text-text-muted hover:not-disabled:bg-[var(--glass-surface-subtle)] hover:not-disabled:text-text-primary",
  danger:
    "border border-recording-pulse/35 bg-recording-pulse/12 text-recording-pulse shadow-[inset_0_1px_0_0_color-mix(in_oklab,white_12%,transparent)] hover:not-disabled:bg-recording-pulse/18",
  outline:
    "border border-[var(--glass-border-strong)] bg-[var(--glass-surface-subtle)] text-text-primary backdrop-blur-sm hover:not-disabled:border-text-muted/40 hover:not-disabled:bg-[var(--glass-surface)]",
};

const SIZES: Record<ButtonSize, string> = {
  xs: "h-7 gap-1.5 rounded-lg px-2.5 text-[11px]",
  sm: "h-8 gap-1.5 rounded-xl px-3 text-xs",
  md: "h-9 gap-2 rounded-xl px-4 text-[13px]",
  lg: "h-11 gap-2.5 rounded-2xl px-5 text-sm",
};

export function buttonClass({
  variant = "secondary",
  size = "md",
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
} = {}): string {
  return cn(
    "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium transition-[background-color,border-color,color,filter,box-shadow,transform] duration-150 disabled:pointer-events-none disabled:opacity-45",
    VARIANTS[variant],
    SIZES[size],
    className,
  );
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leading?: ReactNode;
  trailing?: ReactNode;
};

export function Button({
  variant = "secondary",
  size = "md",
  leading,
  trailing,
  className,
  children,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button type={type} className={buttonClass({ variant, size, className })} {...props}>
      {leading}
      {children}
      {trailing}
    </button>
  );
}
