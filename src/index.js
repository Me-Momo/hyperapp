// 这个h函数用于提供给外部view来生成vnode
// 也是用来保证之后的vnode对比有相同的基础结构和字段
// 非常重要
export function h(name, attributes /*, ...rest*/ ) {
  var node
  var rest = []
  var children = []
  var length = arguments.length

  while (length-- > 2) rest.push(arguments[length])

  while (rest.length) {
    if ((node = rest.pop()) && node.pop /* Array? */ ) {
      for (length = node.length; length--;) {
        rest.push(node[length])
      }
    } else if (node != null && node !== true && node !== false) {
      children.push(node)
    }
  }

  return typeof name === "function" ?
    name(attributes || {}, children) : {
      nodeName: name,
      attributes: attributes || {},
      children: children,
      key: attributes && attributes.key
    }
}

// VNode四板斧，基本的HTML标签都可以被抽象成如下形式：
// {
//   nodeName,
//   attributes,
//   children,
//   key
// }
// TextNode只有一个nodeValue，SVG也是比较特殊，所以在更新时候也会对这两种类型做特殊处理

// 二不管
// 1. 不管vnode生成逻辑（模板语法自由，JSX或者VUE那种形式都行）
// 2. 不管actions管理，action的那些middle以及中间调用不管，只管最终actions形态以及调用&更新

// 唯一
// 1. 初始渲染后，通过调用action来更新状态从而更新视图，这是唯一能触发渲染的途径

// domDiff 原则
// 1. 平级对比，非平级则认为是不一样的dom，直接铲平重建
// 2. 只更新同类型节点，非同类型一样铲平重建
// 3. 尽可能利用现有dom，免除额外的删除创建开销，只需要重新插入(appendChild or insertBefore)
// 4. index&key相同的vdom，对应的dom无需对比，直接复用

export function app(state, actions, view, container) {
  // 渲染锁，保证同一时间只有一个渲染进程在进行
  var renderLock
  // 这个变量暂时只用于决定调用的生命周期hook是create还是update
  var firstRender = true
  // 声明周期的暂存区，所有Hook会在每次渲染完之后一次性清出来执行
  var lifecycleStack = []
  var rootElement = (container && container.children[0]) || null
  // 确切来说应该是第一次渲染之前时候的vdom，这个变量后面会被覆盖使用，新老交替
  var oldNode = rootElement && toVNode(rootElement, [].map)
  // 全局状态，随着组件路径增多，状态也会变深，变多
  var globalState = clone(state)
  var wiredActions = clone(actions)

  // 做的事情有二
  // 1. 将初始状态结合actions执行一次，返回最新状态
  // 2. 根据最新状态，生成vnode，在下一刻执行一次render
  scheduleRender(wireStateToActions([], globalState, wiredActions))

  return wiredActions

  // 也许你发现了，toVNode仅使用了一次，主要考虑到 SSR 的使用场景
  function toVNode(element, map) {
    return {
      nodeName: element.nodeName.toLowerCase(),
      attributes: {},
      children: map.call(element.childNodes, function (element) {
        return element.nodeType === 3 // Node.TEXT_NODE
          ?
          element.nodeValue :
          toVNode(element, map)
      })
    }
  }

  function render() {
    // 没有更新队列的概念，仅保证同一时间只有一个更新进程进行
    renderLock = !renderLock

    // 新的vdom并非出自toVNode的手，而是view函数调用后的结果
    // 需要注意一下vdom结构一致性，不同的vdom结构实现会导致性能问题
    var next = view(globalState, wiredActions)
    if (container && !renderLock) {
      // container存在，并且没有渲染锁，那就开始patch吧..虽然一开始可能是全量patch
      rootElement = patch(container, rootElement, oldNode, (oldNode = next))
      // 每次渲染都得赋值一次，有些许冗余了
      firstRender = false
    }

    // 渲染完了，咚咚咚地将生命周期hook清出来执行
    while ((next = lifecycleStack.pop())) next()
  }

  function scheduleRender() {
    if (!renderLock) {
      renderLock = !renderLock
      setTimeout(render)
    }
  }

  // 粗放版clone，本着"刚刚好就是最好"的原则，既不会浪费性能体积也不会出错
  function clone(target, source) {
    var obj = {}

    for (var i in target) obj[i] = target[i]
    for (var i in source) obj[i] = source[i]

    return obj
  }

  // 粗放版set，"刚刚好就是最好"的原则，既不会浪费性能体积也不会出错
  function set(path, value, source) {
    var target = {}
    if (path.length) {
      target[path[0]] =
        path.length > 1 ? set(path.slice(1), value, source[path[0]]) : value
      return clone(source, target)
    }
    return value
  }

  // 粗放版get，"刚刚好就是最好"的原则，既不会浪费性能体积也不会出错
  function get(path, source) {
    for (var i = 0; i < path.length; i++) {
      source = source[path[i]]
    }
    return source
  }

  function wireStateToActions(path, state, actions) {
    for (var key in actions) {
      // 遍历所有 actions
      typeof actions[key] === "function" ?
        (function (key, action) {
          // 如果有对应的 Action 并且能被调用，改写传入的 Action 
          // 比如去curry化，用高阶函数声明的 Action，转成扁平的函数调用
          // **重要的函数**，在首次渲染以后，只有通过调用 action 变更状态这才能触发视图更新
          actions[key] = function (data) {
            if (typeof (data = action(data)) === "function") {
              data = data(get(path, globalState), actions)
            }

            // 对比状态变化，如果有变化，先更新原有状态（用粗糙版clone合并后覆盖原有状态）
            // 更新完之后触发一次渲染
            // 如果结果返回的是promise（粗糙版的判断），则直接返回
            if (
              data &&
              data !== (state = get(path, globalState)) &&
              !data.then // Promise
            ) {
              scheduleRender(
                (globalState = set(path, clone(state, data), globalState))
              )
            }
            // 返回最新状态
            return data
          }
        })(key, actions[key]) :
        // 如果 actions 是一个比较深的嵌套对象
        // 继续往下递归，按上述逻辑处理
        wireStateToActions(
          path.concat(key),
          (state[key] = state[key] || {}),
          (actions[key] = clone(actions[key]))
        )
    }
  }

  function getKey(node) {
    return node ? node.key : null
  }

  function updateAttribute(element, name, value, isSVG, oldValue) {
    if (name === "key") {} else if (name === "style") {
      for (var i in clone(oldValue, value)) {
        // 如果是style特殊属性，这个属性是一个对象，需要在遍历对象进行赋值
        element[name][i] = value == null || value[i] == null ? "" : value[i]
      }
    } else {
      if (typeof value === "function" || (name in element && !isSVG)) {
        // 如果是元素属性，继续保留即可
        element[name] = value == null ? "" : value
      } else if (value != null && value !== false) {
        // 如果是值属性，仅当值为有效值并且非false才会被设置
        element.setAttribute(name, value)
      }

      if (value == null || value === false) {
        // 如果是空值，或者false值，这个属性可以被删除，减少冗余
        element.removeAttribute(name)
      }
    }
  }

  // 根据不同类型vdom创建迭代对应节点，先创建父节点，再创建子节点，最后从树叶节点开始往回添加
  // 再从树叶节点开始，更新&添加节点属性
  function createElement(node, isSVG) {
    var element =
      typeof node === "string" || typeof node === "number" ?
      document.createTextNode(node) :
      (isSVG = isSVG || node.nodeName === "svg") ?
      document.createElementNS(
        "http://www.w3.org/2000/svg",
        node.nodeName
      ) :
      document.createElement(node.nodeName)

    if (node.attributes) {
      if (node.attributes.oncreate) {
        lifecycleStack.push(function () {
          node.attributes.oncreate(element)
        })
      }

      for (var i = 0; i < node.children.length; i++) {
        element.appendChild(createElement(node.children[i], isSVG))
      }

      for (var name in node.attributes) {
        updateAttribute(element, name, node.attributes[name], isSVG)
      }
    }

    return element
  }

  // 根据新老属性，按需更新节点
  function updateElement(element, oldAttributes, attributes, isSVG) {
    for (var name in clone(oldAttributes, attributes)) {
      // 属性对应值不一样时候才需要更新
      if (
        attributes[name] !==
        (name === "value" || name === "checked" ?
          element[name] :
          oldAttributes[name])
      ) {
        updateAttribute(
          element,
          name,
          attributes[name],
          isSVG,
          oldAttributes[name]
        )
      }
    }

    // 生命周期hook，首次渲染为oncreate，之后为onupdate
    var cb = firstRender ? attributes.oncreate : attributes.onupdate
    if (cb) {
      lifecycleStack.push(function () {
        cb(element, oldAttributes)
      })
    }
  }

  // 从树叶节点开始，递归删除，（没有实际删除，只是递归调用对应的声明周期方法，礼貌性通知一下）
  function removeChildren(element, node, attributes) {
    if ((attributes = node.attributes)) {
      for (var i = 0; i < node.children.length; i++) {
        removeChildren(element.childNodes[i], node.children[i])
      }

      if (attributes.ondestroy) {
        attributes.ondestroy(element)
      }
    }
    return element
  }

  // onremove一旦被定义，它可以决定到底要不要真的爆破
  // ondestory属于通知形式，不能阻止DOM被删除
  function removeElement(parent, element, node, cb) {
    function done() {
      // 各家各户都通知完了，开始爆破！
      parent.removeChild(removeChildren(element, node))
    }

    if (node.attributes && (cb = node.attributes.onremove)) {
      cb(element, done)
    } else {
      done()
    }
  }

  // 父节点，当前节点，老vdom，新vdom，是否svg，兄弟节点
  function patch(parent, element, oldNode, node, isSVG, nextSibling) {
    if (node === oldNode) {
      // vdom一致不更新
    } else if (oldNode == null) {
      // 老vdom为空，插入到当前节点前面
      element = parent.insertBefore(createElement(node, isSVG), element)
    } else if (node.nodeName && node.nodeName === oldNode.nodeName) {
      // 新老vdom属于同一类型节点，更新两者属性等操作，很关键
      updateElement(
        element,
        oldNode.attributes,
        node.attributes,
        (isSVG = isSVG || node.nodeName === "svg")
      )

      // 记录老节点
      var oldElements = []
      // 用key记录老节点
      var oldKeyed = {}
      // 用key记录新节点
      var newKeyed = {}

      // 进行子vdom对比
      // 从第一个老vdom开始记录
      for (var i = 0; i < oldNode.children.length; i++) {
        // 记录老节点
        oldElements[i] = element.childNodes[i]

        // 老vdom
        var oldChild = oldNode.children[i]
        // 老vdom的key
        var oldKey = getKey(oldChild)

        // 老dom的key不为空
        if (null != oldKey) {
          // 关键，记录老节点&对应vdom
          oldKeyed[oldKey] = [oldElements[i], oldChild]
        }
      }

      // i代表老vdom索引，j代表新vdom索引
      var i = 0
      var j = 0

      // 从新vdom第一个开始对比，patch完所有新的vdom
      while (j < node.children.length) {
        var oldChild = oldNode.children[i]
        var newChild = node.children[j]

        var oldKey = getKey(oldChild)
        var newKey = getKey(newChild)

        // 已经有对应key的新vdom了，就不用再对比了
        if (newKeyed[oldKey]) {
          i++
          continue
        }

        if (newKey == null) {
          // 如果新vdom没key
          if (oldKey == null) {
            // 并且如果老vdom也没key，那就直接path，j++，轮到下一个新节点
            patch(element, oldElements[i], oldChild, newChild, isSVG)
            j++
          }
          // 轮到下一个老vdom
          i++
        } else {
          // 如果新vdom有key
          // 保留准备回收的老节点引用
          var recyledNode = oldKeyed[newKey] || []

          if (oldKey === newKey) {
            // 如果新旧key一样，拿老子节点作为当前节点，老vdom，开始递归对比下去
            patch(element, recyledNode[0], recyledNode[1], newChild, isSVG)
            // 下一个老节点
            i++
          } else if (recyledNode[0]) {
            // 如果新老key不一样，但是有老节点，有点神奇的是，拿的不是老节点引用，而是用新key拿到的老节点引用
            // 貌似可以复用老vdom对应新key的节点
            patch(
              element,
              element.insertBefore(recyledNode[0], oldElements[i]),
              recyledNode[1],
              newChild,
              isSVG
            )
          } else {
            // 之前没有过的key的vdom，那就在原来基础上做path，一般是在老节点之前插入新节点
            patch(element, oldElements[i], null, newChild, isSVG)
          }

          // 下一个新节点
          j++
          // 记录这个新vdom已经被patch了
          newKeyed[newKey] = newChild
        }
      }

      // 去除所有没有key的老节点
      while (i < oldNode.children.length) {
        var oldChild = oldNode.children[i]
        if (getKey(oldChild) == null) {
          removeElement(element, oldElements[i], oldChild)
        }
        i++
      }

      // 去除所有没有被复用到的老节点
      for (var i in oldKeyed) {
        if (!newKeyed[oldKeyed[i][1].key]) {
          removeElement(element, oldKeyed[i][0], oldKeyed[i][1])
        }
      }
    } else if (node.nodeName === oldNode.nodeName) {
      // 文字节点，直接更新节点的值
      element.nodeValue = node
    } else {
      // 其他情况，可能不是同类型节点，那就移除老的，创建新的
      element = parent.insertBefore(
        createElement(node, isSVG),
        (nextSibling = element)
      )
      removeElement(parent, nextSibling, oldNode)
    }
    return element
  }
}