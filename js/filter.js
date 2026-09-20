/* A small expression language for area filters.
 *
 *   expr := cond (('&' | 'och' | 'and' | ',') cond)*
 *   cond := term op term
 *   term := atom (('+' | '-') atom)*
 *   atom := PARTY | vänster | höger | valdeltagande | övriga | number | '(' term ')'
 *   op   := < <= > >= = == !=
 *
 * A party symbol (S, M, SD, V, MP, ÖrP and so on) is matched without regard to case.
 * It evaluates to the share of valid votes for that party, in percent.
 * `vänster` and `höger` are the block sums and `valdeltagande` is the turnout, all in percent.
 * The English `left`, `right`, `turnout` and `other` are aliases.
 *
 * compileFilter(text, ctx) returns { test(stats) => bool, vars: [...] }.
 * It throws an Error with a Swedish message when the text does not parse.
 * `stats` is the per-area object that app.js builds (share[], left, right, turnout).
 */
(function () {
  "use strict";

  const OPS = {
    "<": (a, b) => a < b,
    "<=": (a, b) => a <= b,
    ">": (a, b) => a > b,
    ">=": (a, b) => a >= b,
    "=": (a, b) => Math.abs(a - b) < 1e-9,
    "==": (a, b) => Math.abs(a - b) < 1e-9,
    "!=": (a, b) => Math.abs(a - b) >= 1e-9,
  };

  function tokenize(src) {
    const tokens = [];
    const re = new RegExp([
      "\\s*(?:",
      "(\\d+(?:[.,]\\d+)?)",      // 1: number
      "|(<=|>=|==|!=|[<>=])",      // 2: comparison
      "|(and|&&|&|,|och)",         // 3: conjunction
      "|([+\\-()])",               // 4: arithmetic and parentheses
      "|([\\p{L}\\p{N}_]+)",       // 5: identifier
      "|(%)",                      // 6: a stray percent sign, ignored
      ")",
    ].join(""), "giu");
    let m, last = 0;
    while ((m = re.exec(src)) !== null) {
      if (m.index !== last) break;
      last = re.lastIndex;
      if (m[1]) tokens.push({ t: "num", v: parseFloat(m[1].replace(",", ".")) });
      else if (m[2]) tokens.push({ t: "op", v: m[2] });
      else if (m[3]) tokens.push({ t: "and" });
      else if (m[4]) tokens.push({ t: m[4] });
      else if (m[5]) tokens.push({ t: "id", v: m[5] });
      if (m[0].length === 0) re.lastIndex++;
    }
    if (last !== src.length && src.slice(last).trim() !== "") {
      throw new Error("Kan inte tolka: “" + src.slice(last).trim() + "”");
    }
    return tokens;
  }

  function compileFilter(src, ctx) {
    const tokens = tokenize(src);
    let i = 0;
    const vars = new Set();
    const peek = () => tokens[i];
    const next = () => tokens[i++];

    function atom() {
      const tk = next();
      if (!tk) throw new Error("Oväntat slut på uttrycket");
      if (tk.t === "num") { const v = tk.v; return () => v; }
      if (tk.t === "(") {
        const inner = term();
        if (!peek() || peek().t !== ")") throw new Error("Saknar )");
        next();
        return inner;
      }
      if (tk.t === "-") { const a = atom(); return s => -a(s); }
      if (tk.t === "id") {
        const key = tk.v.toLowerCase();
        if (["vänster", "vanster", "left"].includes(key)) {
          vars.add("vänster"); return s => s.left;
        }
        if (["höger", "hoger", "right"].includes(key)) {
          vars.add("höger"); return s => s.right;
        }
        if (["valdeltagande", "deltagande", "turnout"].includes(key)) {
          vars.add("valdeltagande"); return s => s.turnout;
        }
        if (["övriga", "ovriga", "övr", "ovr", "other"].includes(key)) {
          const idx = ctx.partyIndex.get("övr");
          if (idx === undefined) throw new Error("Inga övriga partier i datan");
          vars.add("ÖVR"); return s => s.share[idx];
        }
        const idx = ctx.partyIndex.get(key);
        if (idx === undefined) throw new Error("Okänt parti: " + tk.v);
        vars.add(ctx.parties[idx].abbr);
        return s => s.share[idx];
      }
      throw new Error("Oväntat tecken: " + (tk.v || tk.t));
    }

    function term() {
      let f = atom();
      while (peek() && (peek().t === "+" || peek().t === "-")) {
        const op = next().t;
        const g = atom();
        const h = f;
        f = op === "+" ? s => h(s) + g(s) : s => h(s) - g(s);
      }
      return f;
    }

    function cond() {
      const a = term();
      const tk = next();
      if (!tk || tk.t !== "op") throw new Error("Förväntade jämförelse (<, >, = …)");
      const cmp = OPS[tk.v];
      const b = term();
      return s => cmp(a(s), b(s));
    }

    const conds = [cond()];
    while (peek()) {
      if (peek().t === "and") next();
      conds.push(cond());
    }
    return {
      test: s => { for (const c of conds) if (!c(s)) return false; return true; },
      vars: [...vars],
    };
  }

  window.compileFilter = compileFilter;
})();
