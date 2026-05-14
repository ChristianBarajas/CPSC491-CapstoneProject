import { useRef, useEffect } from "react";
import { useLocation } from "react-router-dom";
import { animate } from "animejs";

export default function PageTransition({ children }) {
  const location = useLocation();
  const containerRef = useRef(null);

  useEffect(() => {
    if (containerRef.current) {
      animate(containerRef.current, {
        opacity: [0, 1],
        translateY: [12, 0],
        duration: 400,
        ease: "out(3)",
      });
    }
  }, [location.pathname]);

  return (
    <div ref={containerRef} style={{ opacity: 0 }}>
      {children}
    </div>
  );
}
