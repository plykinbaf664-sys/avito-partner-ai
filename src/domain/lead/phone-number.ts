const INTERNATIONAL_PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;

export function normalizePhoneNumber(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /[A-Za-zА-Яа-яЁё]/u.test(trimmed)) return null;

  const digits = trimmed.replace(/\D/g, "");
  const normalized =
    digits.length === 11 && digits.startsWith("8")
      ? `+7${digits.slice(1)}`
      : trimmed.startsWith("+")
        ? `+${digits}`
        : digits.length === 11 && digits.startsWith("7")
          ? `+${digits}`
          : null;

  return normalized && INTERNATIONAL_PHONE_PATTERN.test(normalized)
    ? normalized
    : null;
}

