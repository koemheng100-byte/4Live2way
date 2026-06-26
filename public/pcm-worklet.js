class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];

    if (input && input.length > 0) {
      const pcm = input[0];

      // បង្កើត Buffer ថ្មី
      const copy = new Float32Array(pcm.length);
      copy.set(pcm);

      // ផ្ទេរ ArrayBuffer ទៅ Main Thread
      this.port.postMessage(copy, [copy.buffer]);
    }

    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);