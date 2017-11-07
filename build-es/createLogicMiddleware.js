var _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; };

import { Observable } from 'rxjs/Observable'; // eslint-disable-line no-unused-vars
import { Subject } from 'rxjs/Subject';
import { BehaviorSubject } from 'rxjs/BehaviorSubject';
import 'rxjs/add/operator/filter';
import 'rxjs/add/operator/map';
import 'rxjs/add/operator/scan';
import 'rxjs/add/operator/takeWhile';
import 'rxjs/add/operator/toPromise';
import wrapper from './logicWrapper';
import { confirmProps } from './utils';

// confirm custom Rx build imports
confirmProps(Observable.prototype, ['filter', 'map', 'scan', 'takeWhile', 'toPromise'], 'Observable.prototype');

var debug = function debug() /* ...args */{};
var OP_INIT = 'init'; // initial monitor op before anything else

function identity(x) {
  return x;
}

/**
   Builds a redux middleware for handling logic (created with
   createLogic). It also provides a way to inject runtime dependencies
   that will be provided to the logic for use during its execution hooks.

   This middleware has two additional methods:
     - `addLogic(arrLogic)` adds additional logic dynamically
     - `replaceLogic(arrLogic)` replaces all logic, existing logic should still complete

   @param {array} arrLogic array of logic items (each created with
     createLogic) used in the middleware. The order in the array
     indicates the order they will be called in the middleware.
   @param {object} deps optional runtime dependencies that will be
     injected into the logic hooks. Anything from config to instances
     of objects or connections can be provided here. This can simply
     testing. Reserved property names: getState, action, and ctx.
   @returns {function} redux middleware with additional methods
     addLogic and replaceLogic
 */
export default function createLogicMiddleware() {
  var arrLogic = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : [];
  var deps = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};

  if (!Array.isArray(arrLogic)) {
    throw new Error('createLogicMiddleware needs to be called with an array of logic items');
  }
  var duplicateLogic = findDuplicates(arrLogic);
  if (duplicateLogic.length) {
    throw new Error('duplicate logic, indexes: ' + duplicateLogic);
  }

  var actionSrc$ = new Subject(); // mw action stream
  var monitor$ = new Subject(); // monitor all activity
  var lastPending$ = new BehaviorSubject({ op: OP_INIT });
  monitor$.scan(function (acc, x) {
    // append a pending logic count
    var pending = acc.pending || 0;
    switch (x.op) {// eslint-disable-line default-case
      case 'top': // action at top of logic stack
      case 'begin':
        // starting into a logic
        pending += 1;
        break;

      case 'end': // completed from a logic
      case 'bottom': // action cleared bottom of logic stack
      case 'nextDisp': // action changed type and dispatched
      case 'filtered': // action filtered
      case 'dispatchError': // error when dispatching
      case 'cancelled':
        // action cancelled before intercept complete
        // dispCancelled is not included here since
        // already accounted for in the 'end' op
        pending -= 1;
        break;
    }
    return _extends({}, x, {
      pending: pending
    });
  }, { pending: 0 }).subscribe(lastPending$); // pipe to lastPending

  var savedStore = void 0;
  var savedNext = void 0;
  var actionEnd$ = void 0;
  var logicSub = void 0;
  var logicCount = 0; // used for implicit naming
  var savedLogicArr = arrLogic; // keep for uniqueness check

  function mw(store) {
    if (savedStore && savedStore !== store) {
      throw new Error('cannot assign logicMiddleware instance to multiple stores, create separate instance for each');
    }
    savedStore = store;

    return function (next) {
      savedNext = next;

      var _applyLogic = applyLogic(arrLogic, savedStore, savedNext, logicSub, actionSrc$, deps, logicCount, monitor$),
          action$ = _applyLogic.action$,
          sub = _applyLogic.sub,
          cnt = _applyLogic.logicCount;

      actionEnd$ = action$;
      logicSub = sub;
      logicCount = cnt;

      return function (action) {
        debug('starting off', action);
        monitor$.next({ action: action, op: 'top' });
        actionSrc$.next(action);
        return action;
      };
    };
  }

  /**
    observable to monitor flow in logic
    */
  mw.monitor$ = monitor$;

  /**
     Resolve promise when all in-flight actions are complete passing
     through fn if provided
     @param {function} fn optional fn() which is invoked on completion
     @return {promise} promise resolves when all are complete
    */
  mw.whenComplete = function whenComplete() {
    var fn = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : identity;

    return lastPending$
    // .do(x => console.log('wc', x)) /* keep commented out */
    .takeWhile(function (x) {
      return x.pending;
    }).map(function () {
      return (/* x */undefined
      );
    }) // not passing along anything
    .toPromise().then(fn);
  };

  /**
     add additional deps after createStore has been run. Useful for
     dynamically injecting dependencies for the hooks. Throws an error
     if it tries to override an existing dependency with a new
     value or instance.
     @param {object} additionalDeps object of dependencies to add
     @return {undefined}
    */
  mw.addDeps = function addDeps(additionalDeps) {
    if (typeof additionalDeps !== 'object') {
      throw new Error('addDeps should be called with an object');
    }
    Object.keys(additionalDeps).forEach(function (k) {
      var existing = deps[k];
      var newValue = additionalDeps[k];
      if (typeof existing !== 'undefined' && // previously existing dep
      existing !== newValue) {
        // no override
        throw new Error('addDeps cannot override an existing dep value: ' + k);
      }
      // eslint-disable-next-line no-param-reassign
      deps[k] = newValue;
    });
  };

  /**
    add logic after createStore has been run. Useful for dynamically
    loading bundles at runtime. Existing state in logic is preserved.
    @param {array} arrNewLogic array of logic items to add
    @return {object} object with a property logicCount set to the count of logic items
   */
  mw.addLogic = function addLogic(arrNewLogic) {
    if (!arrNewLogic.length) {
      return { logicCount: logicCount };
    }
    var combinedLogic = savedLogicArr.concat(arrNewLogic);
    var duplicateLogic = findDuplicates(combinedLogic);
    if (duplicateLogic.length) {
      throw new Error('duplicate logic, indexes: ' + duplicateLogic);
    }

    var _applyLogic2 = applyLogic(arrNewLogic, savedStore, savedNext, logicSub, actionEnd$, deps, logicCount, monitor$),
        action$ = _applyLogic2.action$,
        sub = _applyLogic2.sub,
        cnt = _applyLogic2.logicCount;

    actionEnd$ = action$;
    logicSub = sub;
    logicCount = cnt;
    savedLogicArr = combinedLogic;
    debug('added logic');
    return { logicCount: cnt };
  };

  mw.mergeNewLogic = function mergeNewLogic(arrMergeLogic) {
    // check for duplicates within the arrMergeLogic first
    var duplicateLogic = findDuplicates(arrMergeLogic);
    if (duplicateLogic.length) {
      throw new Error('duplicate logic, indexes: ' + duplicateLogic);
    }
    // filter out any refs that match existing logic, then addLogic
    var arrNewLogic = arrMergeLogic.filter(function (x) {
      return savedLogicArr.indexOf(x) === -1;
    });
    return mw.addLogic(arrNewLogic);
  };

  /**
   replace all existing logic with a new array of logic.
   In-flight requests should complete. Logic state will be reset.
   @param {array} arrRepLogic array of replacement logic items
   @return {object} object with a property logicCount set to the count of logic items
   */
  mw.replaceLogic = function replaceLogic(arrRepLogic) {
    var duplicateLogic = findDuplicates(arrRepLogic);
    if (duplicateLogic.length) {
      throw new Error('duplicate logic, indexes: ' + duplicateLogic);
    }

    var _applyLogic3 = applyLogic(arrRepLogic, savedStore, savedNext, logicSub, actionSrc$, deps, 0, monitor$),
        action$ = _applyLogic3.action$,
        sub = _applyLogic3.sub,
        cnt = _applyLogic3.logicCount;

    actionEnd$ = action$;
    logicSub = sub;
    logicCount = cnt;
    savedLogicArr = arrRepLogic;
    debug('replaced logic');
    return { logicCount: cnt };
  };

  return mw;
}

function applyLogic(arrLogic, store, next, sub, actionIn$, deps, startLogicCount, monitor$) {
  if (!store || !next) {
    throw new Error('store is not defined');
  }

  if (sub) {
    sub.unsubscribe();
  }

  var wrappedLogic = arrLogic.map(function (logic, idx) {
    var namedLogic = naming(logic, idx + startLogicCount);
    return wrapper(namedLogic, store, deps, monitor$);
  });
  var actionOut$ = wrappedLogic.reduce(function (acc$, wep) {
    return wep(acc$);
  }, actionIn$);
  var newSub = actionOut$.subscribe(function (action) {
    debug('actionEnd$', action);
    try {
      var result = next(action);
      debug('result', result);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('error in mw dispatch or next call, probably in middlware/reducer/render fn:', err);
      var msg = err && err.message ? err.message : err;
      monitor$.next({ action: action, err: msg, op: 'nextError' });
    }
    // at this point, action is the transformed action, not original
    monitor$.next({ nextAction: action, op: 'bottom' });
  });

  return {
    action$: actionOut$,
    sub: newSub,
    logicCount: startLogicCount + arrLogic.length
  };
}

/**
 * Implement default names for logic using type and idx
 * @param {object} logic named or unnamed logic object
 * @param {number} idx  index in the logic array
 * @return {object} namedLogic named logic
 */
function naming(logic, idx) {
  if (logic.name) {
    return logic;
  }
  return _extends({}, logic, {
    name: 'L(' + logic.type.toString() + ')-' + idx
  });
}

/**
  Find duplicates in arrLogic by checking if ref to same logic object
  @param {array} arrLogic array of logic to check
  @return {array} array of indexes to duplicates, empty array if none
 */
function findDuplicates(arrLogic) {
  return arrLogic.reduce(function (acc, x1, idx1) {
    if (arrLogic.some(function (x2, idx2) {
      return idx1 !== idx2 && x1 === x2;
    })) {
      acc.push(idx1);
    }
    return acc;
  }, []);
}