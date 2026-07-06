export function mean(values) {
  const nums = finite(values);
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : null;
}

export function max(values) {
  const nums = finite(values);
  return nums.length ? Math.max(...nums) : null;
}

export function min(values) {
  const nums = finite(values);
  return nums.length ? Math.min(...nums) : null;
}

export function sum(values) {
  const nums = finite(values);
  return nums.length ? nums.reduce((total, value) => total + value, 0) : null;
}

export function count(values, predicate = (value) => value != null) {
  return values.filter((value) => Number.isFinite(Number(value)) && predicate(Number(value))).length;
}

function finite(values) {
  return (Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite);
}
