/** Capability checks only: browser APIs cannot predict GPU driver crashes. */
export async function checkWebGPU(): Promise<GPUAdapter> {
  if (!window.isSecureContext) throw new Error("Open the game over HTTPS or localhost.");
  if (!navigator.gpu) throw new Error("WebGPU is unavailable. Use a browser with WebGPU and hardware acceleration enabled.");
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No WebGPU graphics adapter is available. Check hardware acceleration and graphics drivers.");
  const legacy = adapter as GPUAdapter & { isFallbackAdapter?: boolean };
  if (adapter.info?.isFallbackAdapter || legacy.isFallbackAdapter) {
    throw new Error("Software graphics rendering is not supported for this game.");
  }
  const requirements = {
    maxTextureDimension2D: 640,
    maxBufferSize: 65536,
    maxStorageBufferBindingSize: 65536,
    maxUniformBufferBindingSize: 96,
    maxStorageBuffersPerShaderStage: 3,
    maxUniformBuffersPerShaderStage: 1,
    maxBindingsPerBindGroup: 4,
    maxBindGroups: 1,
  };
  for (const [name, minimum] of Object.entries(requirements)) {
    const available = adapter.limits[name as keyof GPUSupportedLimits];
    if (typeof available !== "number" || available < minimum) {
      throw new Error("This graphics adapter does not meet the game's WebGPU requirements.");
    }
  }
  return adapter;
}
