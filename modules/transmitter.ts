const transmit = {
    encode(data: string) {
      const encoder = new TextEncoder();
      return encoder.encode(data);
    },
  };
  
export default transmit;