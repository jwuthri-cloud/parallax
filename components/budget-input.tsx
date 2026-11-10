"use client";

import { useId } from "react";

export function BudgetInput({
  label,
  period,
  value,
  onChange,
}: {
  label: string;
  period: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const hintId = useId();
  return (
    <label className="budget-field">
      <span>{label}</span>
      <span className="budget-input">
        <span className="budget-currency" aria-hidden="true">
          $
        </span>
        <input
          aria-label={label}
          aria-describedby={hintId}
          type="number"
          inputMode="decimal"
          min="1"
          step="any"
          required
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <span className="budget-unit" aria-hidden="true">
          USD
        </span>
      </span>
      <span className="budget-period" id={hintId}>
        USD · {period}
      </span>
    </label>
  );
}
