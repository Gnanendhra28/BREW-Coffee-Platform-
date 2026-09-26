"use client";

import React from "react";
import Image from "next/image";
import { motion } from "framer-motion";

interface BeanConfig {
  id: number;
  src: string;
  top: string;
  right: string;
  size: number;
  baseRotate: number;
  duration: number;
  delay: number;
  opacity?: number;
  zIndex?: number;
}

const BEANS_DATA: BeanConfig[] = [
  {
    id: 1,
    src: "/assets/bean-1.png",
    top: "33%",
    right: "37%",
    size: 42,
    baseRotate: 25,
    duration: 9.5,
    delay: 0.2,
    opacity: 0.95,
    zIndex: 15,
  },
  {
    id: 2,
    src: "/assets/bean-2.png",
    top: "39%",
    right: "32%",
    size: 50,
    baseRotate: -18,
    duration: 11.2,
    delay: 1.8,
    opacity: 1,
    zIndex: 20,
  },
  {
    id: 3,
    src: "/assets/bean-3.png",
    top: "46%",
    right: "36%",
    size: 54,
    baseRotate: 42,
    duration: 8.8,
    delay: 2.7,
    opacity: 1,
    zIndex: 25,
  },
  {
    id: 4,
    src: "/assets/bean-4.png",
    top: "44%",
    right: "27%",
    size: 46,
    baseRotate: -35,
    duration: 10.4,
    delay: 0.8,
    opacity: 0.95,
    zIndex: 18,
  },
  {
    id: 5,
    src: "/assets/bean-5.png",
    top: "39%",
    right: "19%",
    size: 56,
    baseRotate: 55,
    duration: 12.0,
    delay: 3.2,
    opacity: 1,
    zIndex: 22,
  },
  {
    id: 6,
    src: "/assets/bean-6.png",
    top: "49%",
    right: "23%",
    size: 48,
    baseRotate: 12,
    duration: 9.0,
    delay: 1.4,
    opacity: 0.95,
    zIndex: 19,
  },
  {
    id: 7,
    src: "/assets/bean-7.png",
    top: "43%",
    right: "12%",
    size: 52,
    baseRotate: -45,
    duration: 10.8,
    delay: 2.1,
    opacity: 0.85,
    zIndex: 14,
  },
  {
    id: 8,
    src: "/assets/bean-8.png",
    top: "52%",
    right: "31%",
    size: 40,
    baseRotate: -60,
    duration: 8.4,
    delay: 0.5,
    opacity: 0.9,
    zIndex: 16,
  },
];

export const FloatingBeans: React.FC = () => {
  return (
    <div className="hidden md:block absolute inset-0 pointer-events-none overflow-hidden z-15 select-none">
      {BEANS_DATA.map((bean) => (
        <motion.div
          key={bean.id}
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: bean.opacity ?? 1, scale: 1 }}
          transition={{ duration: 1.2, delay: 0.4 + bean.delay * 0.15 }}
          style={{
            position: "absolute",
            top: bean.top,
            right: bean.right,
            zIndex: bean.zIndex ?? 10,
          }}
        >
          <motion.div
            animate={{
              y: [0, -20, 0],
              rotate: [
                bean.baseRotate,
                bean.baseRotate + 10,
                bean.baseRotate - 10,
                bean.baseRotate,
              ],
            }}
            transition={{
              duration: bean.duration,
              repeat: Infinity,
              ease: "easeInOut",
              delay: bean.delay,
            }}
            className="filter drop-shadow-[0_12px_24px_rgba(0,0,0,0.85)]"
          >
            <Image
              src={bean.src}
              alt="Floating 3D Coffee Bean"
              width={bean.size}
              height={bean.size}
              className="object-contain pointer-events-none"
              style={{
                width: `${bean.size}px`,
                height: "auto",
              }}
            />
          </motion.div>
        </motion.div>
      ))}
    </div>
  );
};
