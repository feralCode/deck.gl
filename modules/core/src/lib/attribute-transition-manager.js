import {Transform} from '@luma.gl/core';
import GPUInterpolationTransition from '../transitions/gpu-interpolation-transition';
import GPUSpringTransition from '../transitions/gpu-spring-transition';
import log from '../utils/log';

export default class AttributeTransitionManager {
  constructor(gl, {id, timeline}) {
    this.id = id;
    this.gl = gl;
    this.timeline = timeline;

    this.transitions = {};
    this.needsRedraw = false;
    this.numInstances = 1;

    if (Transform.isSupported(gl)) {
      this.isSupported = true;
    } else if (gl) {
      // This class may be instantiated without a WebGL context (e.g. web worker)
      log.warn('WebGL2 not supported by this browser. Transition animation is disabled.')();
    }
  }

  finalize() {
    for (const attributeName in this.transitions) {
      this._removeTransition(attributeName);
    }
  }

  /* Public methods */

  // Called when attribute manager updates
  // Check the latest attributes for updates.
  update({attributes, transitions = {}, numInstances}) {
    // Transform class will crash if elementCount is 0
    this.numInstances = numInstances || 1;

    if (!this.isSupported) {
      return;
    }

    for (const attributeName in attributes) {
      const attribute = attributes[attributeName];
      const settings = attribute.getTransitionSetting(transitions);

      // this attribute might not support transitions?
      if (!settings) continue; // eslint-disable-line no-continue
      this._updateAttribute(attributeName, attribute, settings);
    }

    for (const attributeName in this.transitions) {
      const attribute = attributes[attributeName];
      if (!attribute || !attribute.supportsTransition()) {
        // Animated attribute has been removed
        this._removeTransition(attributeName);
      }
    }
  }

  // Returns `true` if attribute is transition-enabled
  hasAttribute(attributeName) {
    return attributeName in this.transitions;
  }

  // Get all the animated attributes
  getAttributes() {
    const animatedAttributes = {};

    for (const attributeName in this.transitions) {
      const transition = this.transitions[attributeName];
      if (transition.isTransitioning()) {
        animatedAttributes[attributeName] = transition.getTransitioningAttribute();
      }
    }

    return animatedAttributes;
  }

  /* eslint-disable max-statements */
  // Called every render cycle, run transform feedback
  // Returns `true` if anything changes
  run() {
    if (!this.isSupported || this.numInstances === 0) {
      return false;
    }

    for (const attributeName in this.transitions) {
      const updated = this.transitions[attributeName].update();
      if (updated) {
        this.needsRedraw = true;
      }
    }

    const needsRedraw = this.needsRedraw;
    this.needsRedraw = false;
    return needsRedraw;
  }
  /* eslint-enable max-statements */

  /* Private methods */
  _removeTransition(attributeName) {
    this.transitions[attributeName].cancel();
    delete this.transitions[attributeName];
  }

  // Check an attributes for updates
  // Returns a transition object if a new transition is triggered.
  _updateAttribute(attributeName, attribute, settings) {
    let isNew = false;

    const transition = this.transitions[attributeName];
    // an attribute can change transition type when it updates
    // let's remove the transition when that happens so we can create the new transition type
    // TODO: when switching transition types, make sure to carry over the attribute's
    // previous buffers, currentLength, bufferLayout, etc, to be used as the starting point
    // for the next transition
    if (!transition || transition.type !== settings.type) {
      if (transition) {
        this._removeTransition(attributeName);
      }

      if (settings.type === 'interpolation') {
        this.transitions[attributeName] = new GPUInterpolationTransition({
          attribute,
          timeline: this.timeline,
          gl: this.gl
        });
      } else if (settings.type === 'spring') {
        this.transitions[attributeName] = new GPUSpringTransition({
          attribute,
          transitionSettings: settings,
          gl: this.gl
        });
      } else {
        throw new Error(
          `AttributeTransitionManager: unsupported transition type '${settings.type}'`
        );
      }
      isNew = true;
    }

    if (isNew || attribute.needsRedraw()) {
      this.needsRedraw = true;
      this.transitions[attributeName].start(this.gl, settings, this.numInstances);
    }
  }
}
