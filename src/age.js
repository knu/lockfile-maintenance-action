const secondsPerUnit = {
  seconds: 1,
  minutes: 60,
  hours: 3600,
  days: 86400,
  weeks: 604800,
  months: 2592000,
};

export function parseAge(value) {
  const match = /^([1-9][0-9]*) (seconds|minutes|hours|days|weeks|months)$/.exec(value);
  const seconds = match && Number(match[1]) * secondsPerUnit[match[2]];
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error(
      'minimum-release-age must be a positive integer followed by a unit, e.g. 3 days',
    );
  }
  return { seconds, minutes: Math.ceil(seconds / 60), days: Math.ceil(seconds / 86400) };
}
