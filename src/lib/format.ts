import type { Money } from "./types";

export const formatMoney = ({ amount, currency }: Money) =>
  new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    maximumFractionDigits: amount % 1 ? 2 : 0,
  }).format(amount);
