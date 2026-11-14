"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "outline";
export type ButtonSize = "xs" | "sm" | "md" | "lg";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-accent-primary text-bg-primary shadow-[inset_0_1px_0_oklch(1_0_0/0.16)] hover:brightness-[1.06] active:brightness-95",
  secondary:
    "border border-border-subtle bg-bg-elevated text-text-primary hover:border-text-muted/35 hover:bg-bg-elevated/80",
  ghost: "text-text-muted hover:bg-bg-elevated/80 hover:text-text-primary",
  danger:
    "border border-recording-pulse/30 bg-recording-pulse/10 text-recording-pulse hover:bg-recording-pulse/15",
  outline:
    "border border-border-subtle bg-transparent text-text-primary hover:border-text-muted/40 hover:bg-bg-elevated/60",
};

const SIZES: Record<ButtonSize, string> = {
  xs: "h-6 gap-1.5 px-2 text-[11px]",
  sm: "h-7 gap-1.5 px-2.5 text-xs",
  md: "h-9 gap-2 px-3.5 text-sm",
  lg: "h-10 gap-2 px-4 text-sm",
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
    "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-brand font-medium transition-[background-color,border-color,color,filter,box-shadow] duration-150 disabled:pointer-events-none disabled:opacity-45",
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
