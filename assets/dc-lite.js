/*
 * dc-lite.js — runtime nhỏ để chạy các màn hình NeuroTriage như trang HTML độc lập.
 * Hỗ trợ: {{path}} holes, <template data-sc="for|if">, sự kiện onClick/onChange,
 * class Component extends DCLogic { renderVals() }, setState → cập nhật DOM tại chỗ (morph).
 * Không phụ thuộc thư viện ngoài.
 */
(function (global) {
  'use strict';

  class DCLogic {
    constructor(props) { this.props = props || {}; this.state = {}; this.__mounted = false; }
    setState(patch, cb) {
      const p = typeof patch === 'function' ? patch(this.state, this.props) : patch;
      this.state = Object.assign({}, this.state, p);
      DC.__schedule(this, cb);
    }
    forceUpdate(cb) { DC.__schedule(this, cb); }
    renderVals() { return {}; }
  }

  const HOLE_FULL = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/;
  const HOLE_ANY = /\{\{\s*([^}]+?)\s*\}\}/g;

  function lookup(path, scope) {
    path = path.trim();
    if (path === 'true') return true;
    if (path === 'false') return false;
    if (path === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(path)) return Number(path);
    if (/^(['"]).*\1$/.test(path)) return path.slice(1, -1);
    const parts = path.split('.');
    let v = scope;
    for (const k of parts) {
      if (v == null) return undefined;
      v = v[k];
    }
    return v;
  }

  function interp(str, scope) {
    return str.replace(HOLE_ANY, (_, p) => {
      const v = lookup(p, scope);
      return v == null ? '' : String(v);
    });
  }

  function eventType(el, attr) {
    const name = attr.slice(2);
    if (name !== 'change') return name;
    const tag = el.localName;
    if (tag === 'select') return 'change';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio' || t === 'file') return 'change';
      return 'input';
    }
    if (tag === 'textarea') return 'input';
    return 'change';
  }

  const PROPS = { checked: 1, value: 1, disabled: 1, selected: 1 };

  function renderNodes(srcParent, scope, outParent) {
    for (const node of Array.from(srcParent.childNodes)) renderNode(node, scope, outParent);
  }

  function renderNode(node, scope, out) {
    if (node.nodeType === 3) {
      out.appendChild(document.createTextNode(interp(node.nodeValue, scope)));
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.localName;
    if (tag === 'template' && node.hasAttribute('data-sc')) {
      const kind = node.getAttribute('data-sc');
      if (kind === 'for') {
        const m = HOLE_FULL.exec(node.getAttribute('list') || '');
        const list = m ? lookup(m[1], scope) : [];
        const as = node.getAttribute('as') || 'item';
        (Array.isArray(list) ? list : []).forEach((item, i) => {
          const s = Object.create(scope);
          s[as] = item; s.$index = i;
          renderNodes(node.content || node, s, out);
        });
      } else if (kind === 'if') {
        const m = HOLE_FULL.exec(node.getAttribute('value') || '');
        const v = m ? lookup(m[1], scope) : node.getAttribute('value');
        if (v) renderNodes(node.content || node, scope, out);
      }
      return;
    }
    if (tag === 'helmet') return;
    const el = node.namespaceURI && node.namespaceURI !== 'http://www.w3.org/1999/xhtml'
      ? document.createElementNS(node.namespaceURI, node.localName)
      : document.createElement(tag);
    el.__h = {}; el.__p = {};
    for (const a of Array.from(node.attributes)) {
      const name = a.name;
      if (name.startsWith('hint-')) continue;
      const full = HOLE_FULL.exec(a.value);
      if (name.length > 2 && name.startsWith('on')) {
        const fn = full ? lookup(full[1], scope) : null;
        if (typeof fn === 'function') el.__h[eventType(node, name)] = fn;
        continue;
      }
      let v = full ? lookup(full[1], scope) : (a.value.indexOf('{{') >= 0 ? interp(a.value, scope) : a.value);
      if (PROPS[name]) {
        if (full) { el.__p[name] = v; if (name !== 'value' && v) el.setAttribute(name, ''); continue; }
        if (name === 'value') el.__p.value = v;
      }
      if (name.startsWith('aria-')) { if (v != null) el.setAttribute(name, String(v)); continue; }
      if (v === false || v == null) continue;
      el.setAttribute(name, v === true ? '' : String(v));
    }
    if (tag === 'textarea' || tag === 'select') {
      renderNodes(node.content || node, scope, el);
    } else {
      renderNodes(node.content && tag === 'template' ? node.content : node, scope, el);
    }
    attachHandlers(el);
    applyProps(el, el.__p);
    out.appendChild(el);
  }

  function attachHandlers(el) {
    el.__ht = el.__ht || {};
    for (const type of Object.keys(el.__h || {})) {
      if (el.__ht[type]) continue;
      el.__ht[type] = true;
      el.addEventListener(type, (e) => {
        const f = el.__h && el.__h[type];
        if (f) f(e);
      });
    }
  }

  function applyProps(el, p) {
    if (!p) return;
    if ('value' in p) {
      const s = p.value == null ? '' : String(p.value);
      if (el.value !== s) el.value = s;
    }
    if ('checked' in p) el.checked = !!p.checked;
    if ('disabled' in p) el.disabled = !!p.disabled;
    if ('selected' in p) el.selected = !!p.selected;
  }

  function syncAttrs(o, n) {
    for (const a of Array.from(o.attributes)) if (!n.hasAttribute(a.name)) o.removeAttribute(a.name);
    for (const a of Array.from(n.attributes)) if (o.getAttribute(a.name) !== a.value) o.setAttribute(a.name, a.value);
  }

  function morph(oldP, newP) {
    const oldKids = Array.from(oldP.childNodes);
    const newKids = Array.from(newP.childNodes);
    for (let i = 0; i < newKids.length; i++) {
      const o = oldKids[i], n = newKids[i];
      if (!o) { oldP.appendChild(n); continue; }
      if (o.nodeType !== n.nodeType || o.nodeName !== n.nodeName) { oldP.replaceChild(n, o); continue; }
      if (o.nodeType === 3) { if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue; continue; }
      if (o.nodeType !== 1) continue;
      syncAttrs(o, n);
      o.__h = n.__h; o.__p = n.__p;
      attachHandlers(o);
      morph(o, n);
      applyProps(o, o.__p);
    }
    for (let i = newKids.length; i < oldKids.length; i++) oldP.removeChild(oldKids[i]);
  }

  const DC = {
    DCLogic,
    __queue: new Set(),
    __cbs: [],
    __schedule(comp, cb) {
      DC.__queue.add(comp);
      if (cb) DC.__cbs.push(cb);
      if (!DC.__pending) {
        DC.__pending = true;
        Promise.resolve().then(() => {
          DC.__pending = false;
          const q = Array.from(DC.__queue); DC.__queue.clear();
          q.forEach(c => c.__render());
          const cbs = DC.__cbs; DC.__cbs = [];
          cbs.forEach(f => f());
        });
      }
    },
    mount(Component, opts) {
      opts = opts || {};
      const tpl = document.getElementById(opts.template || 'dc-template');
      const root = document.getElementById(opts.root || 'dc-root');
      const comp = new Component(opts.props || {});
      comp.__render = function () {
        let vals;
        try { vals = comp.renderVals() || {}; } catch (e) { console.error('[dc-lite] renderVals lỗi', e); return; }
        const frag = document.createElement('div');
        renderNodes(tpl.content, vals, frag);
        if (!comp.__mounted) {
          while (frag.firstChild) root.appendChild(frag.firstChild);
          comp.__mounted = true;
          if (typeof comp.componentDidMount === 'function') comp.componentDidMount();
        } else {
          morph(root, frag);
          if (typeof comp.componentDidUpdate === 'function') comp.componentDidUpdate();
        }
      };
      comp.__render();
      return comp;
    }
  };

  global.DC = DC;
  global.DCLogic = DCLogic;
})(window);
