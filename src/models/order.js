'use strict'

import {
  requirePropertiesMixin,
  freezePropertiesMixin,
  validatePropertiesMixin,
  updatePropertiesMixin,
  processUpdate,
  checkFormat,
  PREVMODEL,
} from './mixins'

/**
 * @typedef {string|RegExp} topic
 * @typedef {function(string)} eventCallback
 * @typedef {import('../adapters/index').adapterFunction} adapterFunction
 * @typedef {string} id
 * 
 * @typedef {Object} Order
 * @property {function(topic,eventCallback)} listen
 * @property {import('../adapters/event-adapter').notifyType} notify
 * @property {adapterFunction} validateAddress
 * @property {adapterFunction} completePayment
 * @property {adapterFunction} verifyDelivery - verify the order was received by the customer
 * @property {adapterFunction} trackShipment
 * @property {adapterFunction} refundPayment
 * @property {adapterFunction} authorizePayment - verify payment info, credit avail
 * @property {import('../adapters/shipping-adapter').shipOrder} shipOrder -
 * calls shipping service to request, or emits event to indicate, that order be shipped
 * @property {function(Order):Promise<void>} save - saves order
 * @property {function():Promise<Order>} find - finds order
 * @property {string} shippingAddress
 * @property {string} orderNo
 * @property {string} trackingId
 * @property {function()} decrypt
 * @property {function(*):Promise<Order>} update 
 * @property {'APPROVED'|'SHIPPING'|'CANCELED'|'COMPLETED'} orderStatus
 */

const MAXORDER = 99999.99;
const orderItems = 'orderItems';
const customerInfo = 'customerInfo';
const billingAddress = 'billingAddress';
const shippingAddress = 'shippingAddress'
const proofOfDelivery = 'proofOfDelivery';
const creditCardNumber = 'creditCardNumber';
const paymentAuthorization = 'paymentAuthorization';
const customerId = 'customerId';
const orderStatus = 'orderStatus';
const orderTotal = 'orderTotal';
const cancelReason = 'cancelReason';
const trackingId = 'trackingId';
const orderNo = 'orderNo';
const OrderStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  SHIPPING: 'SHIPPING',
  COMPLETE: 'COMPLETE',
  CANCELED: 'CANCELED'
}

const checkItems = function (items) {
  if (!items) {
    throw new Error('order contains no items');
  }
  const _items = Array.isArray(items)
    ? items
    : [items];

  if (_items.length > 0
    && _items.every(i => i['itemId']
      && typeof i['price'] === 'number'
    )) {
    return _items;
  }
  throw new Error('order items invalid');
}

const calcTotal = function (items) {
  const _items = checkItems(items);
  return _items.reduce((total, item) => {
    return total += item.price
  }, 0);
}

/**
 * No changes to `propKey` once order is approved
 * @param {*} o - the order
 * @param {*} propKey 
 * @returns {string | null} the key or `null`
 */
const freezeOnApproval = (propKey) => (o) => {
  return o[PREVMODEL].orderStatus !== OrderStatus.PENDING
    ? propKey
    : null;
}

/**
 * No changes to `propKey` once order is complete or canceled
 * @param {*} o - the order
 * @param {*} propKey 
 * @returns {string | null} the key or `null`
 */
const freezeOnCompletion = (propKey) => (o) => {
  return [
    OrderStatus.COMPLETE,
    OrderStatus.CANCELED
  ].includes(o[PREVMODEL].orderStatus)
    ? propKey
    : null;
}

/**
 * Value required to complete order
 * @param {*} o 
 * @param {*} propKey
 * @returns {string | void} the key or `void`
 */
const requiredForCompletion = (propKey) => (o) => {
  if (!o.orderStatus) {
    return;
  }
  return o.orderStatus === OrderStatus.COMPLETE
    ? propKey
    : void 0;
}

const invalidStatusChange = (from, to) => (o, propVal) => {
  return propVal === to && o[PREVMODEL].orderStatus === from;
}

const invalidStatusChanges = [
  // Can't change back to pending once approved
  invalidStatusChange(OrderStatus.APPROVED, OrderStatus.PENDING),
  // Can't change back to pending once shipped
  invalidStatusChange(OrderStatus.SHIPPING, OrderStatus.PENDING),
  // Can't change back to approved once shipped
  invalidStatusChange(OrderStatus.SHIPPING, OrderStatus.APPROVED),
  // Can't change directly to shipping from pending
  invalidStatusChange(OrderStatus.PENDING, OrderStatus.SHIPPING),
  // Can't change directly to complete from pending
  invalidStatusChange(OrderStatus.PENDING, OrderStatus.COMPLETE)
];

/**
 * Check that status changes are valid
 */
export const statusChangeValid = (o, propVal) => {
  if (!o[PREVMODEL]?.orderStatus) {
    return true;
  }
  if (invalidStatusChanges.some(i => i(o, propVal))) {
    throw new Error('invalid status change');
  }
  return true;
}

/** 
 * Don't delete orders before they're complete.
 */
function readyToDelete(model) {
  if (![
    OrderStatus.COMPLETE,
    OrderStatus.CANCELED
  ].includes(model.orderStatus)) {
    throw new Error('order status incomplete');
  }
  return model;
}

/**
 * 
 * @param {Order} order 
 * @returns {Order}
 */
async function findOrder(order) {
  const current = order.find();
  if (!current) {
    return order;
  }
  return current;
}

/**
 * 
 * @param {Order} order 
 * @param {*} changes 
 */
async function updateOrder(order, changes) {
  const current = await findOrder(order);
  const updated = processUpdate(current, changes);
  await updated.save();
  return updated;
}

async function deliveryVerified({ proofOfDelivery, order }) {
  const func = deliveryVerified.name;
  try {
    await order.completePayment();
    const changes = {
      orderStatus: OrderStatus.COMPLETE,
      proofOfDelivery
    };
    const updated = await order.update(changes);
    await handleStatusChange(updated);
  } catch (error) {
    console.error({ func, error, order });
    throw new Error(error);
  }
}

/**
 * Callback invoked by shipping adapter once order has arrived.
 * @param {{order:Order}} order  
 */
async function orderReceived({ order }) {
  const func = orderReceived.name;
  try {
    await order.verifyDelivery(deliveryVerified);
  } catch (error) {
    console.error({ func, error, order });
    throw new Error(error);
  }
}

/**
 * Callback invoked by shipping adapter when order is shipped.
 * @param {{ message:string, 
 *  subscription:{ getModel:function():Order }
 * }} param0 
 */
async function orderShipped({ order }) {
  const func = orderShipped.name;
  try {
    const changes = { orderStatus: OrderStatus.SHIPPING };
    const updated = await order.update(changes);
    await handleStatusChange(updated);
  } catch (error) {
    console.error({ func, error, order });
    throw new Error(error);
  }
}

/**
 * in stock, ready for pickup
 * @param {{order: Order }} param0 
 */
async function orderFilled({ order, pickupAddress }) {
  const func = orderFilled.name
  try {
    const updated = await order.update({ pickupAddress });
    await updated.shipOrder(orderShipped);
  } catch (error) {
    console.error({ func, error, order });
    throw new Error(error);
  }
}

/**
 * Implements the order service workflow.
 */
const OrderActions = {

  /** @param {Order} order */
  [OrderStatus.PENDING]: async (order) => {
    const func = OrderStatus.PENDING;
    try {
      const addrRsp = await order.validateAddress();
      const payment = await order.authorizePayment();
      const { address, isSingleFamily } = addrRsp;
      order.update({
        shippingAddress: address,
        paymentAuthorization: payment,
        signatureRequired: !isSingleFamily
      });
    } catch (error) {
      console.error({ func, error, order });
      throw new Error(error);
    }
  },

  /** @param {Order} order */
  [OrderStatus.APPROVED]: async (order) => {
    const func = OrderStatus.PENDING;
    try {
      await order.fillOrder(orderFilled);
    } catch (error) {
      console.error({ func, error, order });
      throw new Error(error);
    }
  },

  /** @param {Order} order */
  [OrderStatus.SHIPPING]: async (order) => {
    const func = OrderStatus.SHIPPING;
    try {
      await order.trackShipment(orderReceived);
    } catch (error) {
      console.error({ func, error, order });
      throw new Error(error);
    }
  },

  /** @param {Order} order */
  [OrderStatus.CANCELED]: async (order) => {
    const func = OrderStatus.SHIPPING;
    try {
      //await order.returnOrder(orderReturned);
      await order.refundPayment();
    } catch (error) {
      console.error({ func, error, order });
      throw new Error(error);
    }
  },

  /** @param {Order} order */
  [OrderStatus.COMPLETE]: async (order) => {
    // await order.surveyCustomer();
    console.log('customer sentiment')
    return;
  }
}

export async function handleStatusChange(order) {
  return OrderActions[order.orderStatus](order);
}

/**
 * @type {import('./index').ModelSpecification}
 */
const Order = {
  modelName: 'order',
  endpoint: 'orders',
  ports: {
    listen: {
      service: 'Event',
      type: 'inbound',
    },
    notify: {
      service: 'Event',
      type: 'outbound',
    },
    save: {
      service: 'Persistence',
      type: 'outbound'
    },
    find: {
      service: 'Persistence',
      type: 'outbound'
    },
    shipOrder: {
      service: 'Shipping',
      type: 'outbound',
    },
    authorizePayment: {
      service: 'Payment',
      type: 'outbound'
    },
    refundPayment: {
      service: 'Payment',
      type: 'outbound'
    },
    completePayment: {
      service: 'Payment',
      type: 'outbound',
    },
    trackShipment: {
      service: 'Shipping',
      type: 'outbound'
    },
    verifyDelivery: {
      service: 'Shipping',
      type: 'outbound'
    },
    cancelShipment: {
      service: 'Shipping',
      type: 'outbound'
    },
    validateAddress: {
      service: 'Address',
      type: 'outbound'
    },
    fillOrder: {
      service: 'Inventory',
      type: 'outbound'
    }
  },
  factory: function (dependencies) {
    return async function createOrder({
      customerInfo,
      orderItems,
      shippingAddress,
      billingAddress,
      creditCardNumber,
      signatureRequired = false
    }) {
      checkItems(orderItems);
      checkFormat(creditCardNumber, 'creditCard');
      const order = {
        customerInfo,
        orderItems,
        creditCardNumber,
        billingAddress,
        signatureRequired,
        shippingAddress,
        [customerId]: null,
        [paymentAuthorization]: null,
        [orderTotal]: calcTotal(orderItems),
        [orderStatus]: OrderStatus.PENDING,
        [proofOfDelivery]: null,
        [trackingId]: null,
        [cancelReason]: null,
        [orderNo]: dependencies.uuid(),
        async update(changes) {
          return updateOrder(this, changes);
        }
      };
      return Object.freeze(order);
    }
  },
  mixins: [
    requirePropertiesMixin(
      customerInfo,
      orderItems,
      creditCardNumber,
      shippingAddress,
      billingAddress,
      requiredForCompletion(proofOfDelivery)
    ),
    freezePropertiesMixin(
      customerInfo,
      freezeOnApproval(orderItems),
      freezeOnApproval(creditCardNumber),
      freezeOnApproval(shippingAddress),
      freezeOnApproval(billingAddress),
      freezeOnCompletion(orderStatus),
    ),
    updatePropertiesMixin([
      {
        // Recalc total
        propKey: orderItems,
        update: (o, propVal) => ({
          orderTotal: calcTotal(propVal)
        }),
      }
    ]),
    validatePropertiesMixin([
      {
        propKey: orderStatus,
        values: Object.values(OrderStatus),
        isValid: statusChangeValid,
      },
      {
        propKey: orderTotal,
        maxnum: MAXORDER
      }
    ]),
  ],
  onUpdate: processUpdate,
  onDelete: model => readyToDelete(model),
  eventHandlers: [
    async ({ model: order, eventName, changes }) => {
      if (changes?.orderStatus || eventName === 'CREATEORDER') {
        order.save();
        await handleStatusChange(order);
      }
    }
  ]
}

export default Order