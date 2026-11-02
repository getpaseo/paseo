/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 * @format
 *
 * GPUI implements RN's NativeNetworkingAndroid C++ spec, which accepts
 * positional arguments. Keep this adapter in sync with RN's Android wrapper;
 * the iOS wrapper sends an object and is incompatible with that native spec.
 */
import type { EventSubscription } from '../vendor/emitter/EventEmitter';
import type { RequestBody } from './convertRequestBody';
import type { RCTNetworkingEventDefinitions } from './RCTNetworkingEventDefinitions.flow';
import type { NativeResponseType } from './XMLHttpRequest';

import NativeEventEmitter from '../EventEmitter/NativeEventEmitter';
import convertRequestBody from './convertRequestBody';
import NativeNetworkingAndroid from './NativeNetworkingAndroid';

type Header = [string, string];

function convertHeadersMapToArray(headers: Object): Array<Header> {
  const headerArray: Array<Header> = [];
  for (const name in headers) {
    headerArray.push([name, headers[name]]);
  }
  return headerArray;
}

let requestId = 1;
const emitter = new NativeEventEmitter(NativeNetworkingAndroid);

const RCTNetworking = {
  addListener<K extends keyof RCTNetworkingEventDefinitions>(
    eventType: K,
    listener: (...RCTNetworkingEventDefinitions[K]) => unknown,
    context?: unknown,
  ): EventSubscription {
    // $FlowFixMe[incompatible-type]
    return emitter.addListener(eventType, listener, context);
  },

  sendRequest(
    method: string,
    trackingName: string | void,
    url: string,
    headers: Object,
    data: RequestBody,
    responseType: NativeResponseType,
    incrementalUpdates: boolean,
    timeout: number,
    callback: (requestId: number) => unknown,
    withCredentials: boolean,
  ) {
    const body = convertRequestBody(data);
    if (body && body.formData) {
      body.formData = body.formData.map(part => ({
        ...part,
        headers: convertHeadersMapToArray(part.headers),
      }));
    }

    const currentRequestId = requestId++;
    const devToolsRequestId =
      global.__NETWORK_REPORTER__?.createDevToolsRequestId();
    NativeNetworkingAndroid.sendRequest(
      method,
      url,
      currentRequestId,
      convertHeadersMapToArray(headers),
      { ...body, trackingName, devToolsRequestId },
      responseType,
      incrementalUpdates,
      timeout,
      withCredentials,
    );
    callback(currentRequestId);
  },

  abortRequest(currentRequestId: number) {
    NativeNetworkingAndroid.abortRequest(currentRequestId);
  },

  clearCookies(callback: (result: boolean) => void) {
    NativeNetworkingAndroid.clearCookies(callback);
  },
};

export default RCTNetworking;
