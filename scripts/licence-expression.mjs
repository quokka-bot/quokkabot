// Reads an SPDX licence expression as a tree, so grouping holds: in "GPL-2.0-only AND (MIT OR Apache-2.0)" every
// choice includes GPL. OR binds looser than AND, and "X WITH exception" is one licence.
//
// copyleftFree is true when some way of meeting the expression uses no licence `isCopyleft` matches: OR needs one
// side, AND needs both. A licence field that is not an expression ("SEE LICENSE IN LICENSE.md") passes only when no
// copyleft licence is named anywhere in it.
export function copyleftFree(expression, isCopyleft) {
  try {
    return evaluate(expression, isCopyleft);
  } catch {
    return !isCopyleft(expression);
  }
}

function evaluate(expression, isCopyleft) {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let at = 0;
  const keyword = () => tokens[at]?.toUpperCase();
  const fail = () => { throw new Error(`Not a licence expression: ${expression}`); };
  const term = () => {
    const token = tokens[at++];
    if (token === "(") {
      const free = or();
      if (tokens[at++] !== ")") fail();
      return free;
    }
    if (token === undefined || token === ")" || ["AND", "OR", "WITH"].includes(token.toUpperCase())) fail();
    let licence = token;
    if (keyword() === "WITH") {
      at += 1;
      const exception = tokens[at++];
      if (exception === undefined || exception === "(" || exception === ")") fail();
      licence += ` WITH ${exception}`;
    }
    return !isCopyleft(licence);
  };
  const and = () => {
    let free = term();
    while (keyword() === "AND") { at += 1; const right = term(); free = free && right; }
    return free;
  };
  const or = () => {
    let free = and();
    while (keyword() === "OR") { at += 1; const right = and(); free = free || right; }
    return free;
  };
  const free = or();
  if (at !== tokens.length) fail();
  return free;
}
