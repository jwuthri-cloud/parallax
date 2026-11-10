/*
 * Parallax kit: a dependency-free chart renderer shared by the app and by
 * sandboxed HTML reports. Reports opt in with <meta name="parallax-kit">;
 * the server then inlines this file, the kit stylesheet and theme tokens.
 *
 * Chart spec (JSON in <script type="application/json" class="px-chart">):
 *   title, description, type: line | bar | scatter, xLabel, yLabel,
 *   format: auto | percent | fixed | scientific, logY, smoothing (0-0.99),
 *   goal: min | max | none, height,
 *   series: [{ name, unit?, points: [[x, y], ...] | [{ x, y, lower?, upper?, n? }] }]
 *   or, for grouped bars: categories: [...], series: [{ name, values: [...] }]
 *   or source: { experiment: "<id>", panel: "<title>" | metrics: ["loss/*"] }
 */
(function () {
  "use strict";
  if (typeof document === "undefined") return;
  var SVG = "http://www.w3.org/2000/svg";
  var SLOTS = 8;

  function node(tag, attrs, parent, svg) {
    var e = svg
      ? document.createElementNS(SVG, tag)
      : document.createElement(tag);
    for (var k in attrs || {})
      if (attrs[k] !== undefined && attrs[k] !== null) {
        if (k === "text") e.textContent = attrs[k];
        else e.setAttribute(k, attrs[k]);
      }
    if (parent) parent.appendChild(e);
    return e;
  }
  function s(tag, attrs, parent) {
    return node(tag, attrs, parent, true);
  }

  function trim(v, digits) {
    return String(Number(v.toPrecision(digits)));
  }
  function format(value, fmt, unit) {
    if (typeof value !== "number" || !isFinite(value)) return "—";
    var suffix = unit && unit !== "%" ? " " + unit : unit || "";
    if (fmt === "percent") return trim(value * 100, 3) + "%";
    if (fmt === "scientific") return value.toExponential(2) + suffix;
    if (fmt === "fixed") return value.toFixed(3) + suffix;
    var abs = Math.abs(value);
    if (abs !== 0 && (abs < 1e-3 || abs >= 1e7))
      return value.toExponential(2) + suffix;
    if (abs >= 1e4)
      return (
        new Intl.NumberFormat("en", {
          notation: "compact",
          maximumFractionDigits: 2,
        }).format(value) + suffix
      );
    return trim(value, 4) + suffix;
  }
  function niceTicks(min, max, count) {
    if (min === max) {
      var pad = Math.abs(min) * 0.1 || 1;
      min -= pad;
      max += pad;
    }
    var raw = (max - min) / Math.max(1, count);
    var power = Math.pow(10, Math.floor(Math.log10(raw)));
    var step = [1, 2, 5, 10]
      .map(function (m) {
        return m * power;
      })
      .find(function (x) {
        return x >= raw;
      });
    var ticks = [];
    for (
      var t = Math.floor(min / step) * step;
      t <= max + step * 1e-9;
      t += step
    )
      ticks.push(Number(t.toPrecision(12)));
    if (ticks[ticks.length - 1] < max)
      ticks.push(ticks[ticks.length - 1] + step);
    return ticks;
  }
  function logTicks(min, max) {
    var ticks = [];
    for (
      var e = Math.floor(Math.log10(min));
      e <= Math.ceil(Math.log10(max));
      e++
    )
      ticks.push(Math.pow(10, e));
    return ticks;
  }
  function smooth(values, weight) {
    if (!weight) return values;
    var last = values[0];
    return values.map(function (v) {
      return (last = last * weight + (1 - weight) * v);
    });
  }
  function matches(pattern, name) {
    return pattern.slice(-2) === "/*"
      ? name.indexOf(pattern.slice(0, -1)) === 0
      : pattern === name;
  }

  function point(p) {
    if (Array.isArray(p)) return { x: +p[0], y: +p[1] };
    return {
      x: +(p.x !== undefined ? p.x : p.step),
      y: +(p.y !== undefined ? p.y : p.value),
      lower: p.lower,
      upper: p.upper,
      n: p.n,
    };
  }

  /** Resolve a spec (inline data or a recorded experiment) into plottable series. */
  function normalize(spec, data, keepAll) {
    var out = Object.assign(
      {
        type: "line",
        xLabel: "step",
        yLabel: "",
        format: "auto",
        logY: false,
        smoothing: 0,
        goal: "none",
        series: [],
      },
      spec,
    );
    if (spec.source) {
      var exp =
        data && data.experiments && data.experiments[spec.source.experiment];
      if (!exp)
        return Object.assign(out, {
          error: "Experiment not found in this workspace",
        });
      var picked;
      if (spec.source.panel) {
        picked = exp.panels.find(function (p) {
          return p.title === spec.source.panel;
        });
        if (!picked)
          return Object.assign(out, {
            error: 'No chart panel "' + spec.source.panel + '"',
          });
      } else {
        var patterns = spec.source.metrics || [];
        var names = [];
        exp.metrics.forEach(function (m) {
          if (
            names.indexOf(m.name) < 0 &&
            patterns.some(function (p) {
              return matches(p, m.name);
            })
          )
            names.push(m.name);
        });
        picked = {
          title: patterns.join(", "),
          series: names.map(function (name) {
            var pts = exp.metrics.filter(function (m) {
              return m.name === name;
            });
            return { name: name, unit: (pts[0] || {}).unit, points: pts };
          }),
        };
      }
      out = Object.assign({}, picked, out, { series: picked.series });
      if (!spec.title) out.title = picked.title;
      if (!spec.type && picked.type) out.type = picked.type;
    }
    if (spec.categories) {
      out.categories = spec.categories.map(String);
      out.series = (spec.series || []).map(function (sr) {
        return {
          name: sr.name,
          unit: sr.unit || "",
          points: (sr.values || []).map(function (v, i) {
            return {
              x: i,
              y: +v,
              lower: sr.lower ? sr.lower[i] : undefined,
              upper: sr.upper ? sr.upper[i] : undefined,
            };
          }),
        };
      });
    } else {
      out.series = (out.series || []).map(function (sr) {
        return {
          name: sr.name,
          unit: sr.unit || "",
          points: (sr.points || [])
            .map(point)
            .filter(function (p) {
              return isFinite(p.x) && isFinite(p.y);
            })
            .sort(function (a, b) {
              return a.x - b.x;
            }),
        };
      });
      // A bar panel of single measurements: one bar per series, latest value.
      if (out.type === "bar") {
        out.categories = out.series.map(function (sr) {
          return sr.name;
        });
        out.single = true;
      }
    }
    out.extra = Math.max(0, out.series.length - SLOTS);
    out.series = (keepAll ? out.series : out.series.slice(0, SLOTS)).map(
      function (sr, i) {
        return Object.assign(sr, {
          color: "var(--px-series-" + (i + 1) + ")",
          index: i,
        });
      },
    );
    return out;
  }

  function best(series, goal) {
    if (goal !== "min" && goal !== "max") return null;
    return series.points.reduce(function (a, b) {
      if (!a) return b;
      return goal === "min" ? (b.y < a.y ? b : a) : b.y > a.y ? b : a;
    }, null);
  }

  function render(target, spec, data) {
    var chart = normalize(spec, data);
    target.textContent = "";
    target.classList.add("pxc");
    var hidden = target.__pxHidden || (target.__pxHidden = {});
    var head = node("div", { class: "pxc-head" }, target);
    if (chart.title)
      node("div", { class: "pxc-title", text: chart.title }, head);
    if (chart.description)
      node("div", { class: "pxc-desc", text: chart.description }, head);
    if (chart.error) {
      node("div", { class: "pxc-empty", text: chart.error }, target);
      return;
    }
    var visible = chart.series.filter(function (sr) {
      return !hidden[sr.name] && sr.points.length;
    });
    if (
      !chart.series.some(function (sr) {
        return sr.points.length;
      })
    ) {
      node(
        "div",
        { class: "pxc-empty", text: "No measured values yet" },
        target,
      );
      return;
    }
    var grouped = chart.categories && !chart.single;
    if (chart.series.length > 1 && !chart.single) {
      var legend = node(
        "div",
        { class: "pxc-legend", role: "group", "aria-label": "Series" },
        head,
      );
      chart.series.forEach(function (sr) {
        var b = node(
          "button",
          {
            type: "button",
            class: "pxc-key" + (hidden[sr.name] ? " off" : ""),
            "aria-pressed": hidden[sr.name] ? "false" : "true",
            title: hidden[sr.name] ? "Show " + sr.name : "Hide " + sr.name,
          },
          legend,
        );
        node("i", { style: "background:" + sr.color }, b);
        node("span", { text: sr.name }, b);
        b.addEventListener("click", function () {
          hidden[sr.name] = !hidden[sr.name];
          render(target, spec, data);
        });
      });
    }

    var plot = node("div", { class: "pxc-plot" }, target);
    var width = Math.max(280, Math.round(target.clientWidth || 640));
    var height = spec.height || 240;
    var fmt = function (v, unit) {
      return format(v, chart.format, unit);
    };

    // Y domain across visible series, including uncertainty bounds.
    var ys = [];
    visible.forEach(function (sr) {
      var vals =
        chart.type === "line"
          ? smooth(
              sr.points.map(function (p) {
                return p.y;
              }),
              chart.smoothing,
            )
          : [];
      sr.points.forEach(function (p, i) {
        ys.push(p.y);
        if (vals.length) ys.push(vals[i]);
        if (p.lower !== undefined) ys.push(+p.lower);
        if (p.upper !== undefined) ys.push(+p.upper);
      });
    });
    if (!ys.length) ys = [0, 1];
    var log =
      chart.logY &&
      ys.every(function (v) {
        return v > 0;
      });
    var yMin = Math.min.apply(null, ys),
      yMax = Math.max.apply(null, ys);
    if (chart.type === "bar" && !log) {
      yMin = Math.min(0, yMin);
      yMax = Math.max(0, yMax);
    }
    var yTicks = log ? logTicks(yMin, yMax) : niceTicks(yMin, yMax, 5);
    var y0 = yTicks[0],
      y1 = yTicks[yTicks.length - 1];
    var labelWidth = Math.max.apply(
      null,
      yTicks.map(function (t) {
        return fmt(t, "").length;
      }),
    );
    var directLabels =
      chart.type === "line" && visible.length >= 2 && visible.length <= 4;
    var m = {
      l: 14 + labelWidth * 6.4,
      r: directLabels ? 96 : 16,
      t: chart.yLabel ? 24 : 10,
      b: 34,
    };
    var iw = width - m.l - m.r,
      ih = height - m.t - m.b;
    var Y = function (v) {
      var r = log
        ? (Math.log10(v) - Math.log10(y0)) / (Math.log10(y1) - Math.log10(y0))
        : (v - y0) / (y1 - y0 || 1);
      return m.t + ih - r * ih;
    };

    var svg = s(
      "svg",
      {
        viewBox: "0 0 " + width + " " + height,
        width: width,
        height: height,
        role: "img",
        "aria-label":
          (chart.title || "Chart") +
          ": " +
          chart.series
            .map(function (sr) {
              return sr.name;
            })
            .join(", "),
      },
      plot,
    );
    yTicks.forEach(function (t) {
      s(
        "line",
        { x1: m.l, x2: width - m.r, y1: Y(t), y2: Y(t), class: "pxc-grid" },
        svg,
      );
      s(
        "text",
        {
          x: m.l - 8,
          y: Y(t) + 3.5,
          "text-anchor": "end",
          class: "pxc-tick",
          text: fmt(t, ""),
        },
        svg,
      );
    });
    if (chart.yLabel)
      s(
        "text",
        { x: m.l, y: m.t - 10, class: "pxc-axis", text: chart.yLabel },
        svg,
      ).setAttribute("dy", "-0.1em");

    var tip = node("div", { class: "pxc-tip", role: "status" }, plot);
    function showTip(html, px, py) {
      tip.innerHTML = html;
      tip.style.display = "block";
      var left = px + 14,
        top = Math.max(0, py - 10);
      if (left + tip.offsetWidth > width) left = px - tip.offsetWidth - 14;
      tip.style.left = Math.max(0, left) + "px";
      tip.style.top = top + "px";
    }
    function hideTip() {
      tip.style.display = "none";
    }
    function esc(v) {
      return String(v).replace(/[&<>"]/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
      });
    }
    function row(sr, p) {
      var range =
        p.lower !== undefined && p.upper !== undefined
          ? " <small>[" +
            esc(fmt(+p.lower, "")) +
            " – " +
            esc(fmt(+p.upper, "")) +
            "]</small>"
          : "";
      return (
        '<div class="pxc-tip-row"><i style="background:' +
        sr.color +
        '"></i><span>' +
        esc(sr.name) +
        "</span><b>" +
        esc(fmt(p.y, sr.unit)) +
        range +
        (p.n ? " <small>n=" + p.n + "</small>" : "") +
        "</b></div>"
      );
    }

    if (chart.categories) {
      // Bars: one band per category, grouped by series, 2px gap between neighbours.
      var cats = chart.categories;
      var groups = grouped ? visible : [null];
      var band = iw / cats.length;
      var inner = Math.min(band * 0.72, 56 * groups.length);
      var bw = Math.max(2, (inner - 2 * (groups.length - 1)) / groups.length);
      var base = Y(log ? y0 : 0);
      cats.forEach(function (cat, ci) {
        var cx = m.l + band * ci + band / 2;
        s(
          "text",
          {
            x: cx,
            y: height - m.b + 16,
            "text-anchor": "middle",
            class: "pxc-tick",
            text: cat.length > 18 ? cat.slice(0, 17) + "…" : cat,
          },
          svg,
        );
        groups.forEach(function (g, gi) {
          var sr = grouped ? g : chart.series[ci];
          if (!sr || hidden[sr.name]) return;
          var p = grouped ? sr.points[ci] : sr.points[sr.points.length - 1];
          if (!p) return;
          var x = cx - inner / 2 + gi * (bw + 2);
          var top = Y(p.y),
            h = Math.abs(base - top),
            r = Math.min(4, bw / 2, h);
          var up = p.y >= (log ? y0 : 0);
          var yy = up ? top : base;
          var d = up
            ? "M" +
              x +
              "," +
              base +
              "V" +
              (yy + r) +
              "q0,-" +
              r +
              " " +
              r +
              ",-" +
              r +
              "H" +
              (x + bw - r) +
              "q" +
              r +
              ",0 " +
              r +
              "," +
              r +
              "V" +
              base +
              "Z"
            : "M" +
              x +
              "," +
              base +
              "V" +
              (top - r) +
              "q0," +
              r +
              " " +
              r +
              "," +
              r +
              "H" +
              (x + bw - r) +
              "q" +
              r +
              ",0 " +
              r +
              ",-" +
              r +
              "V" +
              base +
              "Z";
          var bar = s("path", { d: d, fill: sr.color, class: "pxc-bar" }, svg);
          if (p.lower !== undefined && p.upper !== undefined) {
            var ex = x + bw / 2;
            s(
              "path",
              {
                d:
                  "M" +
                  ex +
                  "," +
                  Y(+p.lower) +
                  "V" +
                  Y(+p.upper) +
                  "M" +
                  (ex - 4) +
                  "," +
                  Y(+p.lower) +
                  "h8M" +
                  (ex - 4) +
                  "," +
                  Y(+p.upper) +
                  "h8",
                class: "pxc-err",
              },
              svg,
            );
          }
          var hit = s(
            "rect",
            {
              x: x - 1,
              y: m.t,
              width: bw + 2,
              height: ih,
              fill: "transparent",
            },
            svg,
          );
          hit.addEventListener("mouseenter", function () {
            bar.classList.add("hover");
            showTip(
              '<div class="pxc-tip-head">' + esc(cat) + "</div>" + row(sr, p),
              x + bw,
              top,
            );
          });
          hit.addEventListener("mouseleave", function () {
            bar.classList.remove("hover");
            hideTip();
          });
        });
      });
      s(
        "line",
        { x1: m.l, x2: width - m.r, y1: base, y2: base, class: "pxc-base" },
        svg,
      );
    } else {
      var xs = [];
      visible.forEach(function (sr) {
        sr.points.forEach(function (p) {
          xs.push(p.x);
        });
      });
      var x0 = Math.min.apply(null, xs),
        x1 = Math.max.apply(null, xs);
      var X = function (v) {
        return m.l + (x1 === x0 ? iw / 2 : ((v - x0) / (x1 - x0)) * iw);
      };
      var xTicks =
        x1 === x0
          ? [x0]
          : niceTicks(
              x0,
              x1,
              Math.max(2, Math.min(7, Math.floor(iw / 90))),
            ).filter(function (t) {
              return t >= x0 && t <= x1;
            });
      xTicks.forEach(function (t) {
        s(
          "text",
          {
            x: X(t),
            y: height - m.b + 16,
            "text-anchor": "middle",
            class: "pxc-tick",
            text: format(t, "auto", ""),
          },
          svg,
        );
      });
      s(
        "text",
        {
          x: m.l + iw,
          y: height - 4,
          "text-anchor": "end",
          class: "pxc-axis",
          text: chart.xLabel,
        },
        svg,
      );
      var labels = [];
      visible.forEach(function (sr) {
        var vals = smooth(
          sr.points.map(function (p) {
            return p.y;
          }),
          chart.type === "line" ? chart.smoothing : 0,
        );
        if (chart.type === "line") {
          var bounded = sr.points.filter(function (p) {
            return p.lower !== undefined && p.upper !== undefined;
          });
          if (bounded.length > 1)
            s(
              "path",
              {
                d:
                  "M" +
                  bounded
                    .map(function (p) {
                      return X(p.x) + "," + Y(+p.upper);
                    })
                    .join("L") +
                  "L" +
                  bounded
                    .slice()
                    .reverse()
                    .map(function (p) {
                      return X(p.x) + "," + Y(+p.lower);
                    })
                    .join("L") +
                  "Z",
                fill: sr.color,
                class: "pxc-band",
              },
              svg,
            );
          if (chart.smoothing)
            s(
              "polyline",
              {
                points: sr.points
                  .map(function (p) {
                    return X(p.x) + "," + Y(p.y);
                  })
                  .join(" "),
                stroke: sr.color,
                class: "pxc-raw",
              },
              svg,
            );
          s(
            "polyline",
            {
              points: sr.points
                .map(function (p, i) {
                  return X(p.x) + "," + Y(vals[i]);
                })
                .join(" "),
              stroke: sr.color,
              class: "pxc-line",
            },
            svg,
          );
          if (directLabels) {
            var lp = sr.points[sr.points.length - 1];
            labels.push({ y: Y(vals[vals.length - 1]), x: X(lp.x), sr: sr });
          }
        }
        sr.points.forEach(function (p, i) {
          if (chart.type === "line" && bounded_single(p, sr.points.length))
            s(
              "path",
              {
                d: "M" + X(p.x) + "," + Y(+p.lower) + "V" + Y(+p.upper),
                class: "pxc-err",
              },
              svg,
            );
          if (chart.type === "scatter") {
            if (p.lower !== undefined && p.upper !== undefined)
              s(
                "path",
                {
                  d: "M" + X(p.x) + "," + Y(+p.lower) + "V" + Y(+p.upper),
                  class: "pxc-err",
                },
                svg,
              );
            s(
              "circle",
              {
                cx: X(p.x),
                cy: Y(p.y),
                r: 5,
                fill: sr.color,
                class: "pxc-dot",
              },
              svg,
            );
          } else if (sr.points.length <= 30) {
            s(
              "circle",
              {
                cx: X(p.x),
                cy: Y(vals[i]),
                r: 3,
                fill: sr.color,
                class: "pxc-dot",
              },
              svg,
            );
          }
        });
        var b = best(sr, chart.goal);
        if (b) {
          s(
            "circle",
            {
              cx: X(b.x),
              cy: Y(b.y),
              r: 7,
              stroke: sr.color,
              class: "pxc-best",
            },
            svg,
          );
        }
      });
      // Direct labels at line ends, nudged apart so they never overlap.
      labels.sort(function (a, b) {
        return a.y - b.y;
      });
      for (var li = 1; li < labels.length; li++)
        if (labels[li].y - labels[li - 1].y < 13)
          labels[li].y = labels[li - 1].y + 13;
      labels.forEach(function (l) {
        s(
          "text",
          {
            x: width - m.r + 8,
            y: l.y + 3.5,
            class: "pxc-label",
            text:
              l.sr.name.length > 14 ? l.sr.name.slice(0, 13) + "…" : l.sr.name,
          },
          svg,
        );
      });

      // Hover: crosshair snaps to the nearest measured x; scatter reports the nearest point.
      var cross = s(
        "line",
        { y1: m.t, y2: m.t + ih, class: "pxc-cross", visibility: "hidden" },
        svg,
      );
      var marks = s("g", {}, svg);
      var overlay = s(
        "rect",
        { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent" },
        svg,
      );
      var allX = Array.from(new Set(xs)).sort(function (a, b) {
        return a - b;
      });
      overlay.addEventListener("mousemove", function (ev) {
        var rect = svg.getBoundingClientRect();
        var px = ((ev.clientX - rect.left) / rect.width) * width;
        var py = ((ev.clientY - rect.top) / rect.height) * height;
        marks.textContent = "";
        if (chart.type === "scatter") {
          var near = null,
            dist = 24;
          visible.forEach(function (sr) {
            sr.points.forEach(function (p) {
              var d = Math.hypot(X(p.x) - px, Y(p.y) - py);
              if (d < dist) {
                dist = d;
                near = { sr: sr, p: p };
              }
            });
          });
          if (!near) return hideTip();
          s(
            "circle",
            {
              cx: X(near.p.x),
              cy: Y(near.p.y),
              r: 6,
              stroke: near.sr.color,
              class: "pxc-best",
            },
            marks,
          );
          return showTip(
            '<div class="pxc-tip-head">' +
              esc(chart.xLabel) +
              " " +
              esc(format(near.p.x, "auto", "")) +
              "</div>" +
              row(near.sr, near.p),
            X(near.p.x),
            Y(near.p.y),
          );
        }
        var target = allX.reduce(function (a, b) {
          return Math.abs(X(b) - px) < Math.abs(X(a) - px) ? b : a;
        }, allX[0]);
        cross.setAttribute("x1", X(target));
        cross.setAttribute("x2", X(target));
        cross.setAttribute("visibility", "visible");
        var rows = "";
        visible.forEach(function (sr) {
          var vals = smooth(
            sr.points.map(function (p) {
              return p.y;
            }),
            chart.smoothing,
          );
          var i = sr.points.findIndex(function (p) {
            return p.x === target;
          });
          if (i < 0) return;
          var p = Object.assign({}, sr.points[i], { y: vals[i] });
          s(
            "circle",
            {
              cx: X(target),
              cy: Y(vals[i]),
              r: 4,
              fill: sr.color,
              class: "pxc-dot",
            },
            marks,
          );
          rows += row(
            sr,
            chart.smoothing
              ? Object.assign(p, { lower: undefined, upper: undefined })
              : p,
          );
        });
        showTip(
          '<div class="pxc-tip-head">' +
            esc(chart.xLabel) +
            " " +
            esc(format(target, "auto", "")) +
            (chart.smoothing ? " · smoothed" : "") +
            "</div>" +
            rows,
          X(target),
          py,
        );
      });
      overlay.addEventListener("mouseleave", function () {
        cross.setAttribute("visibility", "hidden");
        marks.textContent = "";
        hideTip();
      });
    }

    // Per-series summary: latest value and, when a goal is set, the best one.
    var foot = node("div", { class: "pxc-foot" }, target);
    chart.series.forEach(function (sr) {
      if (!sr.points.length) return;
      var last = sr.points[sr.points.length - 1];
      var b = best(sr, chart.goal);
      var item = node("span", { class: "pxc-stat" }, foot);
      node("i", { style: "background:" + sr.color }, item);
      node("span", { text: sr.name }, item);
      node("b", { text: fmt(last.y, sr.unit) }, item);
      if (b)
        node(
          "small",
          {
            text:
              (chart.goal === "min" ? "min " : "max ") +
              fmt(b.y, sr.unit) +
              (chart.categories ? "" : " @ " + format(b.x, "auto", "")),
          },
          item,
        );
    });
    if (chart.extra)
      node(
        "span",
        {
          class: "pxc-stat muted",
          text: "+" + chart.extra + " more series in the table",
        },
        foot,
      );

    // Every chart has a table view: identity never relies on color alone.
    var details = node("details", { class: "pxc-table" }, target);
    node("summary", { text: "Data table" }, details);
    var wrap = node("div", { class: "pxc-table-scroll" }, details);
    var table = node("table", {}, wrap);
    var fullSeries = normalize(spec, data, true).series;
    var hr = node("tr", {}, node("thead", {}, table));
    node("th", { text: chart.categories ? "" : chart.xLabel }, hr);
    fullSeries.forEach(function (sr) {
      node("th", { text: sr.name + (sr.unit ? " (" + sr.unit + ")" : "") }, hr);
    });
    var body = node("tbody", {}, table);
    var keys =
      chart.categories && !chart.single
        ? chart.categories.map(function (c, i) {
            return { label: c, x: i };
          })
        : chart.single
          ? [{ label: "latest", x: null }]
          : Array.from(
              new Set(
                [].concat.apply(
                  [],
                  fullSeries.map(function (sr) {
                    return sr.points.map(function (p) {
                      return p.x;
                    });
                  }),
                ),
              ),
            )
              .sort(function (a, b) {
                return a - b;
              })
              .map(function (x) {
                return { label: format(x, "auto", ""), x: x };
              });
    keys.forEach(function (k) {
      var tr = node("tr", {}, body);
      node("td", { text: k.label }, tr);
      fullSeries.forEach(function (sr) {
        var p =
          k.x === null
            ? sr.points[sr.points.length - 1]
            : sr.points.find(function (q) {
                return q.x === k.x;
              });
        var cell = p
          ? fmt(p.y, sr.unit) +
            (p.lower !== undefined && p.upper !== undefined
              ? " [" + fmt(+p.lower, "") + " – " + fmt(+p.upper, "") + "]"
              : "") +
            (p.n ? " · n=" + p.n : "")
          : "—";
        node("td", { text: cell }, tr);
      });
    });
  }
  function bounded_single(p, count) {
    return count === 1 && p.lower !== undefined && p.upper !== undefined;
  }

  /** Render and keep the chart sized to its container. */
  function mount(target, spec, data) {
    var draw = function () {
      try {
        render(target, spec, data);
      } catch (e) {
        target.textContent = "Chart could not be drawn: " + (e && e.message);
      }
    };
    draw();
    var lastWidth = target.clientWidth;
    if (typeof ResizeObserver !== "undefined") {
      var observer = new ResizeObserver(function () {
        if (Math.abs(target.clientWidth - lastWidth) < 4) return;
        lastWidth = target.clientWidth;
        draw();
      });
      observer.observe(target);
      return function () {
        observer.disconnect();
      };
    }
    return function () {};
  }

  /** Report pages: render every JSON chart block and make px-table headers sortable. */
  function autoMount() {
    var data = window.__PARALLAX_DATA || {};
    document
      .querySelectorAll('script[type="application/json"].px-chart')
      .forEach(function (block) {
        var holder = document.createElement("figure");
        holder.className = "px-chart-figure";
        block.parentNode.insertBefore(holder, block.nextSibling);
        try {
          mount(holder, JSON.parse(block.textContent || "{}"), data);
        } catch (e) {
          holder.textContent = "Invalid chart JSON: " + (e && e.message);
          holder.classList.add("pxc-empty");
        }
      });
    document.querySelectorAll("table.px-table").forEach(function (table) {
      table.querySelectorAll("thead th").forEach(function (th, col) {
        th.tabIndex = 0;
        th.title = "Sort";
        var sort = function () {
          var dir = th.dataset.dir === "asc" ? "desc" : "asc";
          table.querySelectorAll("thead th").forEach(function (h) {
            delete h.dataset.dir;
          });
          th.dataset.dir = dir;
          var body = table.tBodies[0];
          Array.from(body.rows)
            .sort(function (a, b) {
              var x = a.cells[col] ? a.cells[col].textContent.trim() : "";
              var y = b.cells[col] ? b.cells[col].textContent.trim() : "";
              var nx = parseFloat(x.replace(/[,%]/g, "")),
                ny = parseFloat(y.replace(/[,%]/g, ""));
              var c =
                isFinite(nx) && isFinite(ny) ? nx - ny : x.localeCompare(y);
              return dir === "asc" ? c : -c;
            })
            .forEach(function (r) {
              body.appendChild(r);
            });
        };
        th.addEventListener("click", sort);
        th.addEventListener("keydown", function (e) {
          if (e.key === "Enter") sort();
        });
      });
    });
  }

  window.ParallaxKit = { mount: mount, render: render, format: format };
  // The server injects this script before the opt-in meta tag is parsed.
  function start() {
    if (document.querySelector('meta[name="parallax-kit"]')) autoMount();
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", start);
  else start();
})();
